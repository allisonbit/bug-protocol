/*
  ESP32 temperature reporter and relay actuator for Swamp (swampai.world)

  What it does
    1. Reports its temperature every REPORT_INTERVAL_MS (default 60s).
    2. On every report it collects any commands waiting for it and ACTS on the
       ones it can: "relay on", "relay off" and "relay on for N minutes" drive
       a relay (or an LED) on RELAY_PIN. Everything else is acknowledged
       honestly as not acted on.
    3. Raises an alert when the temperature crosses ALERT_ABOVE_C, with
       hysteresis so it does not spam the bus.

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
    - Arduino IDE with the ESP32 board package installed.
    - Libraries: ArduinoJson (Tools > Manage Libraries > search "ArduinoJson").

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

const unsigned long REPORT_INTERVAL_MS = 60UL * 1000UL;  // one report per minute
const unsigned long RECONNECT_MS = 20UL * 1000UL;        // wifi retry cadence

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
bool alertSent = false;

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

// ---------- report + collect commands ----------
// The reply carries any commands still waiting. One PUT per minute, batched.
void reportOnce(float tempC) {
  HTTPClient http;
  http.begin(String(HOST) + REPORT_PATH);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Machine-Token", token);

  StaticJsonDocument<512> doc;
  JsonArray readings = doc.createNestedArray("readings");
  JsonObject t = readings.createNestedObject();
  t["kind"] = "telemetry";
  t["metric"] = "temperature";
  t["value"] = (double)((int)(tempC * 10 + 0.5)) / 10.0;  // one decimal
  t["unit"] = "c";
  JsonObject r = readings.createNestedObject();
  r["kind"] = "event";
  char st[48];
  if (!relayKnown) {
    strncpy(st, "relay unknown after power-up", sizeof(st));
  } else if (relayOn && relayOffAt) {
    snprintf(st, sizeof(st), "relay on, timed, %lu min left", (unsigned long)((relayOffAt - millis()) / 60000UL));
  } else {
    strncpy(st, relayOn ? "relay on" : "relay off", sizeof(st));
  }
  r["state"] = st;
  r["message"] = "relay state, reported as an event so the record shows what the pin did";

  String body;
  serializeJson(doc, body);
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

// ---------- alert ----------
// Alerts are the one reading with its own topic on the public bus. The machine
// sends one when its own threshold is crossed, with a message a human could
// act on, and the red mark on the Harbour building follows this record.
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
}

void loop() {
  ensureWifi();
  serviceTimedRelay();
  if (WiFi.status() != WL_CONNECTED || token.length() == 0) {
    delay(1000);
    return;
  }
  unsigned long now = millis();
  if (now - lastReport >= REPORT_INTERVAL_MS || lastReport == 0) {
    lastReport = now;
    float tempC = readTemperatureC();
    Serial.printf("[loop] temperature %.1f c, reporting\n", tempC);
    reportOnce(tempC);
    maybeAlert(tempC);
  }
  delay(500);
}
