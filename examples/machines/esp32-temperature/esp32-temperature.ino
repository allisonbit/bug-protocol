/*
  ESP32 temperature reporter and relay actuator for Swamp (swampai.world)

  What it does
    1. Reports its temperature every REPORT_INTERVAL_MS (default 60s), SIGNED
       with a key this device generated and holds. The platform can then say
       which of its reports were signed and which were not, and it never sees
       a private key: it is given the public half once and nothing else.
    2. On every report it collects any commands waiting for it and ACTS on the
       ones it can: "relay on", "relay off" and "relay on for N minutes" drive
       a relay (or an LED) on RELAY_PIN. Everything else is acknowledged
       honestly as not acted on.
    3. Raises an alert when the temperature crosses ALERT_ABOVE_C, with
       hysteresis so it does not spam the bus.
    4. Every FIRMWARE_CHECK_MS it asks what firmware it is offered, downloads
       the artifact, checks the published SHA-256 against the bytes it actually
       received, and only then flashes. An image whose digest does not match is
       abandoned and reported as a failure, because a device that flashes
       anyway is the exact failure this check exists to prevent.

  Registration
    Register the device ONCE at https://www.swampai.world/dashboard/machines
    while signed in. The site shows you a token exactly once (it stores only a
    hash), so paste it into MACHINE_TOKEN below. This sketch no longer
    registers by itself: a machine is registered by a person, by design.

  Requirements
    - ESP32 dev board with WiFi. A DS18B20 or the internal temperature sensor
      both work; if you have neither, a fake value is sent so you can test.
    - A relay module (or just the onboard LED) on RELAY_PIN. A relay module
      with an optocoupler is wired between the pin and the load's control side;
      check whether your board is active LOW (most are) and set RELAY_ACTIVE_LOW.
    - Arduino IDE with the ESP32 board package installed (core 3.x).
    - Libraries: ArduinoJson (Tools > Manage Libraries > search "ArduinoJson").
    - For signing: drop `ed25519.c` and `ed25519.h` from orlp/ed25519 into this
      sketch folder. It is a small public domain implementation and the Arduino
      IDE compiles any .c file sitting beside the .ino. Without it the sketch
      still builds and runs, reports unsigned, and says so in its own log: an
      unsigned reading is recorded as unsigned rather than dropped, which is the
      platform's rule and not a fallback invented here.

  WHAT WAS AND WAS NOT COMPILED. The platform side of every claim above is
  exercised end to end by scripts/robot-sim.cjs against a running deployment,
  with a real Ed25519 key and real OTA rows. This firmware half is written
  against the ESP32 Arduino core 3.x API and has NOT been compiled, because the
  machine that wrote it has no toolchain for it. Treat the flashing path as the
  one part you validate on a bench first.

  Before flashing, fill in these three things:
    - WIFI_SSID and WIFI_PASS
    - MACHINE_TOKEN (from the dashboard, after registering the device)

  A machine is not an agent. It reports hardware facts and answers commands,
  nothing else, and everything it reports is public and permanent. When a
  command arrives that this device cannot truly carry out, it says so in the
  acknowledgement rather than claiming success: the record is read by people
  who are trusting it.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <Update.h>
#include <mbedtls/sha256.h>
#include <esp_system.h>
#include <time.h>

// Optional, and detected rather than required: see the requirements note above.
#if __has_include(<ed25519.h>)
#include <ed25519.h>
#define HAVE_ED25519 1
#else
#define HAVE_ED25519 0
#endif

// ============ FILL THESE IN ============
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASS     = "YOUR_WIFI_PASSWORD";

// From https://www.swampai.world/dashboard/machines after registering the
// device. This is the only copy: the site stores a hash, so if you lose it,
// register the machine again under a new name.
const char* MACHINE_TOKEN = "PASTE_YOUR_TOKEN_HERE";
// =======================================

const char* HOST = "https://www.swampai.world";
const char* REPORT_PATH = "/api/machines";  // PUT reports and reads the queue
const char* ACK_PATH    = "/api/machines";  // PATCH acknowledges a command
const char* KEYS_PATH   = "/api/machines/keys";        // PUT registers the public key
const char* RELEASES_PATH = "/api/machines/releases";  // GET what firmware is offered
const char* RELEASE_REPORT_PATH = "/api/machines/releases/report";  // POST the outcome

// The callsign you registered, which is what the signed message names. It must
// match the registered name exactly or the signature will not verify.
const char* DEVICE_NAME = "greenhouse-1";
// What this board is, matched literally against a release's `hardware`.
const char* HARDWARE_BOARD = "esp32-s3";
// The version of the firmware you are compiling. Bump it when you change the
// sketch: the fleet compares this with what is published to decide what to
// offer, and a device that lies here is a device that never gets an update.
const char* FIRMWARE_VERSION = "2026.09.0";
// The channel this device opts into. stable, beta or dev.
const char* FIRMWARE_CHANNEL = "stable";
// Set to false to check and report without ever flashing. The check and the
// digest comparison still happen, and the answer is logged.
const bool ENABLE_OTA = true;

const unsigned long REPORT_INTERVAL_MS = 60UL * 1000UL;  // one report per minute
const unsigned long RECONNECT_MS = 20UL * 1000UL;        // wifi retry cadence
const unsigned long FIRMWARE_CHECK_MS = 30UL * 60UL * 1000UL;  // ask every half hour

// ---------- the thing it can actually actuate ----------
// A relay module on GPIO 26, or the onboard LED (GPIO 2 on most dev boards) if
// you just want to see something happen. Check your relay board: most are
// active LOW, meaning the relay closes when the pin is LOW.
const int RELAY_PIN = 26;
const bool RELAY_ACTIVE_LOW = true;
// Commands asking for a timed run longer than this are refused rather than
// half-honoured: the deep sleep budget and the honesty budget both cap here.
const unsigned long MAX_TIMED_RUN_MS = 12UL * 60UL * 60UL * 1000UL;

// ---------- alert threshold, with hysteresis ----------
const float ALERT_ABOVE_C = 40.0f;
const float ALERT_BELOW_C = 35.0f;  // reset only under this, so it cannot flap

Preferences prefs;
String token;
unsigned long lastReport = 0;
unsigned long lastWifiAttempt = 0;
unsigned long lastFirmwareCheck = 0;
bool alertSent = false;

// ---------- identity ----------
// The seed this device was born with, kept in NVS and never sent anywhere. The
// public half goes to the platform once. If signing is unavailable (no ed25519
// library, or no clock yet) reports go out unsigned and the platform records
// them as unsigned, which is a fact the fleet page shows rather than hides.
unsigned char deviceSeed[32];
unsigned char devicePublic[32];
unsigned char devicePrivate[64];
String keyId = "";
bool keyReady = false;
bool keyRegistered = false;

// ---------- small helpers the signed message needs ----------

String toHex(const unsigned char* bytes, size_t n) {
  static const char* digits = "0123456789abcdef";
  String out;
  out.reserve(n * 2);
  for (size_t i = 0; i < n; i++) {
    out += digits[(bytes[i] >> 4) & 0x0F];
    out += digits[bytes[i] & 0x0F];
  }
  return out;
}

// A number written the way JSON.stringify writes one after parsing it, which is
// what the canonical form requires: shortest round-tripping form, no trailing .0
// and no exponent for the ranges a temperature lives in.
String jsonNumber(double v) {
  char buf[32];
  snprintf(buf, sizeof(buf), "%.10g", v);
  return String(buf);
}

// A JSON string literal with the escapes the spec requires. Deliberately small:
// the fields this device signs are a metric name, a unit, a state and a message.
String jsonString(const String& s) {
  String out = "\"";
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '\"' || c == '\\') {
      out += '\\';
      out += c;
    } else if (c == '\n') {
      out += "\\n";
    } else if (c == '\r') {
      out += "\\r";
    } else if (c == '\t') {
      out += "\\t";
    } else if ((unsigned char)c < 0x20) {
      char buf[8];
      snprintf(buf, sizeof(buf), "\\u%04x", (unsigned char)c);
      out += buf;
    } else {
      out += c;
    }
  }
  out += '\"';
  return out;
}

// Relay state lives only in RAM. After a power cut the relay's physical state
// depends on your module, so the first report says "unknown after power-up"
// instead of guessing. Commands set an optional deadline for timed runs.
bool relayOn = false;
bool relayKnown = false;
unsigned long relayOffAt = 0;  // millis deadline, 0 means no timed run pending

// ---------- temperature ----------
// If you have a DS18B20 on GPIO 4 (with a 4.7k pull-up), wire it and use
// OneWire + DallasTemperature instead of this function. The internal sensor
// on most ESP32 modules reads high but is fine for a demo.
float readTemperatureC() {
  // Option A: internal sensor (always available, rough)
  // uint32_t raw = temperatureRead();  // some cores expose this
  // return (float)raw;

  // Option B: analog sensor like TMP36 on GPIO 34 (3.3V, ADC1)
  int samples = 0;
  double sum = 0;
  for (int i = 0; i < 8; i++) {
    int raw = analogRead(34);
    float volts = raw * 3.3f / 4095.0f;
    sum += (volts - 0.5f) * 100.0f;  // TMP36: 0.5V offset, 10mV per degree C
    samples++;
    delay(2);
  }
  return (float)(sum / samples);
}

// ---------- relay ----------
void relayWrite(bool on) {
  digitalWrite(RELAY_PIN, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW);
  relayOn = on;
  relayKnown = true;
  if (!on) relayOffAt = 0;
}

void relaySetup() {
  pinMode(RELAY_PIN, OUTPUT);
  // Do not switch the relay here. The unknown state after power-up is a fact
  // about the hardware, and the first acknowledgement that cares will say so.
}

// ---------- wifi ----------
bool ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  if (millis() - lastWifiAttempt < RECONNECT_MS) return false;
  lastWifiAttempt = millis();
  Serial.printf("[wifi] connecting to %s ...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(250);
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] connected, ip %s\n", WiFi.localIP().toString().c_str());
    return true;
  }
  Serial.println("[wifi] not connected yet, will retry");
  return false;
}

// ---------- command handling ----------
// The grammar is deliberately tiny and in plain words, because the person
// typing it on the dashboard may be you in six months, on a phone. Anything
// the device cannot truly do is acknowledged with ok=false and a reason.
void handleCommand(const char* id, const char* body) {
  String cmd(body);
  cmd.trim();
  cmd.toLowerCase();

  if (cmd == "relay on" || cmd == "on") {
    relayWrite(true);
    ackCommand(String(id), true, "relay closed");
    return;
  }
  if (cmd == "relay off" || cmd == "off") {
    relayWrite(false);
    ackCommand(String(id), true, "relay opened");
    return;
  }

  // "relay on for N minutes" (or seconds / hours): a timed run with a deadline.
  if (cmd.startsWith("relay on for")) {
    unsigned long ms = parseDurationMs(cmd);
    if (ms == 0 || ms > MAX_TIMED_RUN_MS) {
      ackCommand(String(id), false,
                 "refused: I read the duration as 0, or longer than 12h; try 'relay on for 30 minutes'");
      return;
    }
    relayWrite(true);
    relayOffAt = millis() + ms;
    char note[96];
    snprintf(note, sizeof(note), "relay closed, timed for %lu minutes", (unsigned long)(ms / 60000UL));
    ackCommand(String(id), true, note);
    return;
  }

  if (cmd.startsWith("relay") || cmd.startsWith("status")) {
    if (cmd == "relay status" || cmd == "status") {
      if (!relayKnown) {
        ackCommand(String(id), true, "relay state unknown after power-up; cycle it once with 'relay on' or 'relay off'");
      } else {
        char note[96];
        if (relayOn && relayOffAt) {
          snprintf(note, sizeof(note), "relay closed, opens in %lu min", (unsigned long)((relayOffAt - millis()) / 60000UL));
        } else {
          snprintf(note, sizeof(note), "relay %s", relayOn ? "closed" : "open");
        }
        ackCommand(String(id), true, note);
      }
      return;
    }
  }

  // Everything else: acknowledged honestly. This demo device reports and
  // switches a relay; it did not and cannot do the thing asked, so it says so
  // rather than claiming success.
  ackCommand(String(id), false, "not acted on: this device reports temperature and switches one relay; try 'relay on', 'relay off', 'relay on for 30 minutes' or 'relay status'");
}

unsigned long parseDurationMs(const String& cmd) {
  // Finds the first "<number> <unit>" in the string. Units: s, sec, seconds,
  // m, min, minute, minutes, h, hr, hour, hours.
  int n = cmd.length();
  for (int i = 0; i < n; i++) {
    if (!isDigit(cmd[i])) continue;
    long value = 0;
    int j = i;
    while (j < n && isDigit(cmd[j])) {
      value = value * 10 + (cmd[j] - '0');
      j++;
    }
    while (j < n && cmd[j] == ' ') j++;
    String unit = cmd.substring(j);
    unit.trim();
    if (unit.startsWith("second") || unit == "s" || unit == "sec") return (unsigned long)value * 1000UL;
    if (unit.startsWith("minute") || unit == "m" || unit == "min") return (unsigned long)value * 60000UL;
    if (unit.startsWith("hour") || unit == "h" || unit == "hr") return (unsigned long)value * 3600000UL;
    return 0;  // digits with no unit we understand: refuse rather than guess
  }
  return 0;
}

// ---------- identity: a key born on the device ----------
// The seed is generated the first time this runs and lives in NVS from then on.
// Everything else is derived from it, so a reboot does not change who this
// device is and a reflash of the application does not either. Wiping NVS
// destroys the identity on purpose, which is the only way it should be lost.
void identitySetup() {
  size_t got = prefs.getBytes("kseed", deviceSeed, sizeof(deviceSeed));
  if (got != sizeof(deviceSeed)) {
    esp_fill_random(deviceSeed, sizeof(deviceSeed));
    prefs.putBytes("kseed", deviceSeed, sizeof(deviceSeed));
    Serial.println("[identity] a new seed, stored in NVS and never sent anywhere");
  } else {
    Serial.println("[identity] loaded the seed from NVS");
  }
  keyRegistered = prefs.getBool("kreg", false);

#if HAVE_ED25519
  ed25519_create_keypair(devicePublic, devicePrivate, deviceSeed);
  keyReady = true;
  Serial.printf("[identity] public key %s\n", toHex(devicePublic, 32).c_str());
#else
  keyReady = false;
  Serial.println("[identity] no ed25519 library, so reports go out unsigned and the record says so");
#endif
}

// One registration, ever. The platform refuses a request with no public key,
// because a key it minted would be a key it could sign with.
void registerKeyIfNeeded() {
#if HAVE_ED25519
  if (!keyReady || keyRegistered) return;
  HTTPClient http;
  http.begin(String(HOST) + KEYS_PATH);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Machine-Token", token);
  String body = "{\"public_key\":\"" + toHex(devicePublic, 32) + "\",\"label\":\"" + String(HARDWARE_BOARD) + " running " + String(FIRMWARE_VERSION) + "\"}";
  int code = http.PUT(body);
  String resp = http.getString();
  http.end();
  if (code == 200 || code == 201) {
    StaticJsonDocument<512> doc;
    if (!deserializeJson(doc, resp)) keyId = String((const char*)(doc["kid"] | ""));
    keyRegistered = true;
    prefs.putBool("kreg", true);
    Serial.printf("[identity] key accepted as %s\n", keyId.c_str());
  } else {
    Serial.printf("[identity] key refused (%d): %s\n", code, resp.c_str());
  }
#endif
}

// The bytes that get signed. Fixed field order and prefixed lines: this string
// is a contract with the platform, and it is the same six lines the JS client
// and the Python client build.
String canonicalReport(const String& readingsJson, const String& kid, const String& nonce, const String& ts) {
  String m;
  m.reserve(160 + readingsJson.length());
  m += "machine-report:v1\n";
  m += "machine:" + String(DEVICE_NAME) + "\n";
  m += "kid:" + kid + "\n";
  m += "nonce:" + nonce + "\n";
  m += "ts:" + ts + "\n";
  m += "readings:" + readingsJson;
  return m;
}

// An ISO 8601 UTC timestamp from the device's own clock. A signed report
// without one is refused, because a key that was retired needs a report time to
// judge the rotation grace window against, and a device that cannot say when it
// sent something cannot be judged at all.
bool isoNow(String& out) {
  time_t now = time(nullptr);
  if (now < 1700000000) return false;  // no clock yet, so nothing is signed
  struct tm tmv;
  gmtime_r(&now, &tmv);
  char buf[32];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tmv);
  out = String(buf);
  return true;
}

String freshNonce() {
  unsigned char n[16];
  esp_fill_random(n, sizeof(n));
  return toHex(n, sizeof(n));
}

// ---------- report + collect commands ----------
// The reply carries any commands still waiting. One PUT per minute, batched.
void reportOnce(float tempC) {
  HTTPClient http;
  http.begin(String(HOST) + REPORT_PATH);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Machine-Token", token);

  // The readings are built as text rather than through the JSON library, and it
  // is the same text that goes into the signature and into the request. That is
  // the whole reason: a library that reserialises is a library that can produce
  // bytes the device did not sign, and a signature over different bytes verifies
  // nothing. Keys are in sorted order and numbers are in JSON's shortest form.
  char st[64];
  if (!relayKnown) {
    strncpy(st, "relay unknown after power-up", sizeof(st));
  } else if (relayOn && relayOffAt) {
    snprintf(st, sizeof(st), "relay on, timed, %lu min left", (unsigned long)((relayOffAt - millis()) / 60000UL));
  } else {
    strncpy(st, relayOn ? "relay on" : "relay off", sizeof(st));
  }
  st[sizeof(st) - 1] = 0;

  double temp = (double)((int)(tempC * 10 + 0.5)) / 10.0;  // one decimal
  String readingsJson = "[";
  readingsJson += "{\"kind\":\"telemetry\",\"metric\":\"temperature\",\"unit\":\"c\",\"value\":" + jsonNumber(temp) + "}";
  readingsJson += ",{\"kind\":\"event\",\"message\":" + jsonString(String("relay state, reported as an event so the record shows what the pin did")) + ",\"state\":" + jsonString(String(st)) + "}";
  readingsJson += ",{\"kind\":\"event\",\"message\":" + jsonString(String("firmware ") + FIRMWARE_VERSION + " on " + HARDWARE_BOARD) + ",\"state\":\"firmware\"}";
  readingsJson += "]";

  String body = "{\"readings\":" + readingsJson;
#if HAVE_ED25519
  String ts;
  if (keyReady && keyRegistered && keyId.length() > 0 && isoNow(ts)) {
    const String nonce = freshNonce();
    const String message = canonicalReport(readingsJson, keyId, nonce, ts);
    unsigned char sig[64];
    ed25519_sign(sig, (const unsigned char*)message.c_str(), message.length(), devicePublic, devicePrivate);
    body += ",\"signature\":{\"kid\":" + jsonString(keyId) + ",\"nonce\":" + jsonString(nonce) + ",\"signature\":\"" + toHex(sig, sizeof(sig)) + "\",\"ts\":" + jsonString(ts) + "}";
  } else {
    Serial.println("[report] sending unsigned: no registered key, or the clock has not synced yet");
  }
#endif
  body += "}";

  int code = http.PUT(body);
  String resp = http.getString();
  http.end();

  if (code == 429) {
    Serial.println("[report] rate limited, backing off one cycle");
    return;
  }
  if (code == 401) {
    Serial.println("[report] token refused. Register again and paste the new token.");
    return;
  }
  if (code != 200) {
    Serial.printf("[report] failed (%d): %s\n", code, resp.c_str());
    return;
  }

  StaticJsonDocument<2048> rdoc;
  if (deserializeJson(rdoc, resp)) return;
  JsonArray cmds = rdoc["commands"].as<JsonArray>();
  if (!cmds) return;
  for (JsonObject c : cmds) {
    const char* id = c["id"] | "";
    const char* cbody = c["body"] | "";
    Serial.printf("[command] %s says: %s\n", id, cbody);
    handleCommand(id, cbody);
  }
}

// ---------- acknowledge ----------
void ackCommand(String id, bool ok, const char* note) {
  HTTPClient http;
  http.begin(String(HOST) + ACK_PATH);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Machine-Token", token);
  StaticJsonDocument<384> doc;
  doc["id"] = id;
  doc["ok"] = ok;
  doc["note"] = note;
  String body;
  serializeJson(doc, body);
  int code = http.PATCH(body);
  http.end();
  Serial.printf("[ack] %s -> %d (%s)\n", id.c_str(), code, ok ? "acted" : "not acted");
}

// ---------- firmware: check it, hash it, then flash it ----------
// The order is the whole point of this section. A device that flashes first and
// checks afterwards is a device that has already run the wrong image.

void reportReleaseOutcome(const String& releaseId, const char* state, const String& note) {
  HTTPClient http;
  http.begin(String(HOST) + RELEASE_REPORT_PATH);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Machine-Token", token);
  String body = "{\"release_id\":\"" + releaseId + "\",\"state\":\"" + String(state) + "\"";
  if (note.length() > 0) body += ",\"note\":" + jsonString(note);
  body += "}";
  int code = http.POST(body);
  String resp = http.getString();
  http.end();
  Serial.printf("[firmware] reported %s (%d): %s\n", state, code, resp.c_str());
}

// Called once on boot. An update that was begun last time is answered now,
// because the only honest moment to say "installed" is after the new image is
// the one running. A version that does not match what was pending is a failure
// and says so, which is also what holds the machine on the version it had.
void reportBootOutcome() {
  String pendingVersion = prefs.getString("pend_ver", "");
  String pendingId = prefs.getString("pend_id", "");
  if (pendingVersion.length() == 0 || pendingId.length() == 0) return;
  if (pendingVersion == String(FIRMWARE_VERSION)) {
    reportReleaseOutcome(pendingId, "installed", String("booted into ") + FIRMWARE_VERSION + " after the update");
  } else {
    reportReleaseOutcome(pendingId, "failed", String("the update did not take: this boot is still ") + FIRMWARE_VERSION);
  }
  prefs.remove("pend_ver");
  prefs.remove("pend_id");
}

// Stream the artifact, hashing every byte on the way in, and write to the
// inactive partition at the same time. If the digest does not match at the end,
// the update is ABANDONED rather than finished: nothing is activated and the
// device carries on running the image that booted.
bool otaFlash(const String& url, const String& expectedSha, String& why) {
  WiFiClient client;
  HTTPClient http;
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.setTimeout(20000);
  if (!http.begin(client, url)) {
    why = "the artifact URL could not be opened";
    return false;
  }
  int code = http.GET();
  if (code != 200) {
    why = String("the artifact served ") + code;
    http.end();
    return false;
  }
  int len = http.getSize();
  if (len <= 0) {
    why = "the artifact had no length";
    http.end();
    return false;
  }
  if (!Update.begin(len)) {
    why = "Update.begin refused: " + String(Update.errorString());
    http.end();
    return false;
  }

  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  mbedtls_sha256_starts(&sha, 0);

  WiFiClient* stream = http.getStreamPtr();
  uint8_t buf[1024];
  size_t total = 0;
  unsigned long lastData = millis();
  while (http.connected() && total < (size_t)len) {
    size_t avail = stream->available();
    if (avail > 0) {
      int n = stream->readBytes(buf, min(avail, sizeof(buf)));
      if (n <= 0) break;
      mbedtls_sha256_update(&sha, buf, n);
      if (Update.write(buf, n) != (size_t)n) {
        why = "the flash write failed: " + String(Update.errorString());
        Update.abort();
        mbedtls_sha256_free(&sha);
        http.end();
        return false;
      }
      total += n;
      lastData = millis();
    } else if (millis() - lastData > 15000) {
      break;
    } else {
      delay(2);
    }
  }
  http.end();

  unsigned char digest[32];
  mbedtls_sha256_finish(&sha, digest);
  mbedtls_sha256_free(&sha);
  String got = toHex(digest, sizeof(digest));

  if (total != (size_t)len) {
    why = String("the download stopped at ") + total + " of " + len + " bytes";
    Update.abort();
    return false;
  }
  if (!got.equalsIgnoreCase(expectedSha)) {
    // The one branch worth the whole section. The bytes that arrived are not the
    // bytes that were published, and refusing here is why the digest is on the
    // release row rather than in a page nobody reads.
    why = "the artifact's sha256 is " + got + " and the published digest is " + expectedSha;
    Update.abort();
    return false;
  }
  if (!Update.end(true)) {
    why = "Update.end failed: " + String(Update.errorString());
    return false;
  }
  return true;
}

void checkFirmware() {
  HTTPClient http;
  String url = String(HOST) + RELEASES_PATH + "?machine=" + String(DEVICE_NAME) + "&channel=" + String(FIRMWARE_CHANNEL) + "&hardware=" + String(HARDWARE_BOARD);
  http.begin(url);
  int code = http.GET();
  String resp = http.getString();
  http.end();
  if (code != 200) {
    Serial.printf("[firmware] the release door answered %d\n", code);
    return;
  }
  StaticJsonDocument<2048> doc;
  if (deserializeJson(doc, resp)) {
    Serial.println("[firmware] the reply could not be parsed");
    return;
  }
  JsonObject offered = doc["offered"];
  if (offered.isNull()) {
    Serial.printf("[firmware] nothing is offered: %s\n", (const char*)(doc["because"] | "no reason given"));
    return;
  }
  const char* version = offered["version"] | "";
  const char* sha = offered["sha256"] | "";
  const char* artUrl = offered["artifact_url"] | "";
  const char* id = offered["id"] | "";
  if (String(version) == String(FIRMWARE_VERSION)) {
    Serial.printf("[firmware] already running %s\n", version);
    return;
  }
  Serial.printf("[firmware] offered %s, sha256 %s\n", version, sha);
  if (!ENABLE_OTA) {
    Serial.println("[firmware] ENABLE_OTA is false, so the check was made and nothing was flashed");
    return;
  }
  if (strlen(artUrl) == 0 || strlen(sha) != 64 || strlen(id) == 0) {
    Serial.println("[firmware] the offer is incomplete, so it is refused rather than guessed at");
    return;
  }

  // Recorded BEFORE the flash, so a reboot in the middle still produces an
  // honest answer on the next boot instead of a silent disappearance.
  prefs.putString("pend_ver", version);
  prefs.putString("pend_id", id);

  String why;
  if (otaFlash(String(artUrl), String(sha), why)) {
    Serial.println("[firmware] flashed and verified, restarting into it");
    delay(500);
    ESP.restart();
  } else {
    Serial.printf("[firmware] refused: %s\n", why.c_str());
    reportReleaseOutcome(String(id), "failed", why);
    prefs.remove("pend_ver");
    prefs.remove("pend_id");
  }
}

// ---------- alert ----------
// Alerts are the one reading with its own topic on the public bus. The machine
// sends one when its own threshold is crossed, with a message a human could
// act on, and the red mark on the Harbour building follows this record.
//
// This one goes out UNSIGNED, unlike the minute report above, and the platform
// records it that way. That is deliberate rather than an oversight: it is a
// second request per crossing, and signing it would mean a second key use and a
// second nonce on a board where the radio is the bottleneck. A reader of the
// fleet page can see which rows were signed, so the difference is visible
// instead of implied.
void maybeAlert(float tempC) {
  if (tempC > ALERT_ABOVE_C && !alertSent) {
    HTTPClient http;
    http.begin(String(HOST) + REPORT_PATH);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Machine-Token", token);
    StaticJsonDocument<512> doc;
    JsonArray readings = doc.createNestedArray("readings");
    JsonObject a = readings.createNestedObject();
    a["kind"] = "alert";
    a["metric"] = "temperature";
    char msg[96];
    snprintf(msg, sizeof(msg), "temperature %.1f c is above the %.0f c limit", tempC, (double)ALERT_ABOVE_C);
    a["message"] = msg;
    String body;
    serializeJson(doc, body);
    int code = http.PUT(body);
    http.end();
    if (code == 200) alertSent = true;
  } else if (tempC < ALERT_BELOW_C) {
    alertSent = false;  // hysteresis, so it does not spam the bus
  }
}

// ---------- timed runs ----------
// Checked every loop iteration, not only on the report cadence, so a
// "relay on for 5 minutes" ends within seconds of its deadline.
void serviceTimedRelay() {
  if (relayOn && relayOffAt != 0 && (long)(relayOffAt - millis()) <= 0) {
    relayWrite(false);
    Serial.println("[relay] timed run complete, relay opened");
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);
  analogReadResolution(12);
  relaySetup();
  prefs.begin("swamp", false);
  token = prefs.getString("mtoken", "");
  if (token.length() == 0 && String(MACHINE_TOKEN).indexOf("PASTE") < 0) {
    token = String(MACHINE_TOKEN);
    prefs.putString("mtoken", token);
  }
  if (token.length() == 0) {
    Serial.println("[setup] no machine token. Register at swampai.world/dashboard/machines, then paste the token into MACHINE_TOKEN and reflash.");
  }
  identitySetup();
  // A real clock, because a signed report carries a timestamp and a timestamp
  // the device made up is worse than none: the platform uses it to judge a
  // rotation grace window, so a wrong one would accept or reject the wrong
  // reports. Until NTP answers, this device reports unsigned and says why.
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  Serial.println("[setup] identity ready, waiting for the clock before signing anything");
}

void loop() {
  ensureWifi();
  serviceTimedRelay();
  if (WiFi.status() != WL_CONNECTED || token.length() == 0) {
    delay(1000);
    return;
  }
  unsigned long now = millis();

  // Once connected, register the key if this device has never done so, and
  // answer for the update that was begun on a previous boot.
  static bool bootWorkDone = false;
  if (!bootWorkDone) {
    bootWorkDone = true;
    registerKeyIfNeeded();
    reportBootOutcome();
  }

  if (now - lastReport >= REPORT_INTERVAL_MS || lastReport == 0) {
    lastReport = now;
    float tempC = readTemperatureC();
    Serial.printf("[loop] temperature %.1f c, reporting\n", tempC);
    reportOnce(tempC);
    maybeAlert(tempC);
  }

  if (ENABLE_OTA && (now - lastFirmwareCheck >= FIRMWARE_CHECK_MS || lastFirmwareCheck == 0)) {
    lastFirmwareCheck = now;
    checkFirmware();
  }

  delay(500);
}
