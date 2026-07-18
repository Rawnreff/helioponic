"""Debug: login, decode JWT, check user_id vs device owner."""
import json, urllib.request, base64

def api(method, path, data=None, headers=None):
    h = headers or {}
    body = json.dumps(data).encode() if data else None
    if body:
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(f"http://localhost:8000/api/v1{path}", data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        return json.loads(e.read()), e.code

# Login
res, code = api("POST", "/auth/login", data={"email": "debug@test.com", "password": "debug123456"})
print(f"Login: {code}")
print(f"User: {res.get('user')}")

token = res["token"]
# Decode JWT payload (middle part)
parts = token.split(".")
if len(parts) == 3:
    # Add padding
    payload = parts[1] + "=" * (4 - len(parts[1]) % 4)
    decoded = base64.urlsafe_b64decode(payload)
    print(f"JWT payload: {json.loads(decoded)}")

h = {"Authorization": f"Bearer {token}"}

# List devices
res2, code2 = api("GET", "/devices", headers=h)
print(f"\nDevices: {code2}")
print(json.dumps(res2, indent=2, default=str))
