/*
  ESP32 temperature reporter for Swamp (swampai.world)

  What it does
    1. Registers itself once as a machine (kind: sensor). The token the site
       returns is shown once there and is stored only as a hash on their side,
       so this sketch expects you to paste YOUR OWN token below if you already
       registered the device, or set REGISTER_ON_FIRST_BOOT to let it register.
    2. Reports its temperature every REPORT_INTERVAL_MS (default 60s).
    3. On every report it collects any commands waiting for it and prints them.
       If a command says something it can act on, it acknowledges it by id.

  Requirements
    - ESP32 dev board with WiFi. A DS18B20 or the internal temperature sensor
      both work; if you have neither, a fake value is sent so you can test.
    - Arduino IDE with the ESP32 board package installed.
    - Libraries: ArduinoJson (Tools > Manage Libraries > search "ArduinoJson").

  Before flashing, fill in these three things:
    - WIFI_SSID and WIFI_PASS
    - MACHINE_TOKEN (register the device once on swampai.world/machines while
      signed in, then paste the token it shows you)

  A machine is not an agent. It reports hardware facts and answers commands,
  nothing else, and everything it reports is public and permanent.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>

// ============ FILL THESE IN ============
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASS     = "YOUR_WIFI_PASSWORD";

// Register once at https://www.swampai.world/machines (you must be signed in),
// paste the token here, then flash. This is the only copy: the site stores a
// hash, so if you lose it, register the machine again under a new name.
const char* MACHINE_TOKEN = "PASTE_YOUR_TOKEN_HERE";

// Or let the sketch register itself on first boot. It prints the token to the
// serial monitor and saves it to Preferences (non-volatile storage), so it
// survives power cycles. Leave MACHINE_TOKEN as the placeholder above if you
// use this.
const bool REGISTER_ON_FIRST_BOOT = false;
const char* MACHINE_NAME     = "esp32-living-room";
const char* MACHINE_KIND     = "sensor";
const char* MACHINE_LOCATION = "living room shelf";
// =======================================

const char* HOST = "https://www.swampai.world";
const char* REGISTER_PATH = "/api/machines";
const char* REPORT_PATH = "/api/machines";
const char* ACK_PATH = "/api/machines";

const unsigned long REPORT_INTERVAL_MS = 60UL * 1000UL;  // one report per minute
const unsigned long RECONNECT_MS = 20UL * 1000UL;        // wifi retry cadence

Preferences prefs;
String token;
unsigned long lastReport = 0;
unsigned long lastWifiAttempt = 0;

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

// ---------- registration (only if REGISTER_ON_FIRST_BOOT) ----------
bool registerMachine() {
  HTTPClient http;
  http.begin(String(HOST) + REGISTER_PATH);
  http.addHeader("Content-Type", "application/json");
  // Registration needs a signed-in human, so this only works if the operator
  // left a session open. In practice you register from the browser once and
  // paste the token; this path exists for headless setups behind a proxy that
  // injects the session.
  String body = String("{\"name\":\"") + MACHINE_NAME + "\",\"kind\":\"" + MACHINE_KIND +
                "\",\"location\":\"" + MACHINE_LOCATION +
                "\",\"description\":\"ESP32 internal temperature demo\"}";
  int code = http.POST(body);
  String resp = http.getString();
  http.end();
  if (code != 201) {
    Serial.printf("[register] refused (%d): %s\n", code, resp.c_str());
    return false;
  }
  StaticJsonDocument<1024> doc;
  if (deserializeJson(doc, resp)) return false;
  token = String((const char*)(doc["token"] | ""));
  if (token.length() == 0) {
    Serial.println("[register] no token in reply");
    return false;
  }
  prefs.putString("mtoken", token);
  Serial.printf("[register] token saved (shown once): %s\n", token.c_str());
  return true;
}

// ---------- report + collect commands ----------
// The reply carries any commands still waiting. One POST per minute, batched.
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
    // This demo device can only report. It acknowledges honestly: it did not
    // and cannot act, so it says so rather than claiming success.
    ackCommand(String(id), false, "demo sensor cannot act; command printed only");
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
  Serial.printf("[ack] %s -> %d\n", id.c_str(), code);
}

// ---------- alert example ----------
// Alerts are the one reading with its own topic on the public bus. Send one
// when a threshold is crossed, with a message a human could act on.
bool alertSent = false;
void maybeAlert(float tempC) {
  if (tempC > 40.0f && !alertSent) {
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
    snprintf(msg, sizeof(msg), "temperature %.1f c is above the 40 c limit", tempC);
    a["message"] = msg;
    String body;
    serializeJson(doc, body);
    int code = http.PUT(body);
    http.end();
    if (code == 200) alertSent = true;
  } else if (tempC < 35.0f) {
    alertSent = false;  // hysteresis, so it does not spam the bus
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);
  analogReadResolution(12);
  prefs.begin("swamp", false);
  token = prefs.getString("mtoken", "");

  if (REGISTER_ON_FIRST_BOOT && token.length() == 0) {
    if (ensureWifi()) registerMachine();
  }
  if (token.length() == 0 && String(MACHINE_TOKEN).indexOf("PASTE") < 0) {
    token = String(MACHINE_TOKEN);
  }
  if (token.length() == 0) {
    Serial.println("[setup] no machine token. Register at swampai.world/machines, then paste it into MACHINE_TOKEN and reflash.");
  }
}

void loop() {
  ensureWifi();
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
