# Phone ↔ Pi Connection (hotspot mode)

The phone is the front end, the Pi is the brain. They talk over one small
network. Two ways to get there:

- **Phone hotspot** (recommended for the field - no router needed)
- **Any Wi-Fi** where both are on the same subnet

## 1. Phone creates the hotspot

On the phone:

- Settings → **Personal Hotspot / Tethering** → ON
- Note the **network name (SSID)** and **password**
- Android hotspots normally use `192.168.43.1` for the phone, so the Pi gets
  `192.168.43.x`

## 2. Pi joins the hotspot

```bash
# see the hotspot in range
nmcli device wifi list

# connect (use the phone's hotspot SSID + password)
nmcli device wifi connect "PHONE-HOTSPOT-NAME" password "your-password"

# check the Pi's hotspot IP
ip -4 addr show wlo1 | grep inet
# -> inet 192.168.43.57/24 brd 192.168.43.255 ...
```

Leave the phone hotspot on the whole time - it is the router.

## 3. Start the mission server on the Pi

```bash
mission-server
```

It prints the address the phone should use:

```
[DISCOVERY] listening for phone probes on UDP 9999
[SERVER] listening on http://0.0.0.0:8080  (simulated mode)
[SERVER] reachable from the phone at http://192.168.43.57:8080
```

## 4. The app finds the Pi automatically

Tap **Find Pi** in the app. The app broadcasts a UDP probe
(`WEEDLASER_DISCOVER` on port 9999); the Pi answers with its address, so no
IP typing is needed. The app then shows:

```
Pi: Bayazid-HS (192.168.43.57)
```

Then: tap **Send image to Pi** (the primary button) - the phone uploads the
photo + the 4 corner points, the Pi does the CV (BEV warp, vegetation
segmentation, row detection), builds the coverage mission and starts the
rover. The app then polls `GET /status` every second and shows
`rows 5/9 · weeds killed 7 · remaining 2`.

There is a second button that sends the mission JSON the phone computed
itself - useful when the Pi cannot see the photo, but the image flow is the
one to use in the field.

## Same thing from the laptop (no phone)

```bash
end-to-end-sim          # probes for the Pi automatically, then runs the mission
python3 Navigation/src/pi_discovery.py 3   # just find the Pi
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| App says "No rover Pi found" | Pi not on the same network, or server not running (`mission-server`) |
| Discovery works, HTTP fails | Firewall: `sudo ufw allow 8080/tcp` and `sudo ufw allow 9999/udp` |
| Phone hotspot assigns `192.168.0.x` | fine, the Pi just reports whatever it got - the app uses the discovered address |
| Discovery works from the laptop but not the phone | Some hotspots enable **AP/client isolation** - both devices must be able to talk to each other |
| `Address already in use` on the server | Another server holds port 8080: `pkill -f mission_server.py` |

## Protocol summary

| Direction | Transport | Payload |
|---|---|---|
| app → Pi | UDP broadcast `:9999` | `WEEDLASER_DISCOVER` |
| Pi → app | UDP unicast `:9999` | `{"service":"weedlaser","name":"pi","host":"192.168.43.57","port":8080}` |
| app → Pi | HTTP POST `:8080/image` | `{image: base64 jpeg, corners: 4 points, field: {...}}` - the Pi answers with the plan it computed |
| app → Pi | HTTP GET `:8080/artifacts/<file>` | the BEV / plan-overlay images the Pi produced |
| app → Pi | HTTP POST `:8080/mission` | the mission JSON (rows + path) |
| app → Pi | HTTP GET `:8080/status` | live status (rows done, weeds killed, state) |
| app → Pi | HTTP GET `:8080/plan` | the parsed plan (debugging) |
| app → Pi | HTTP GET `:8080/health` | liveness |
