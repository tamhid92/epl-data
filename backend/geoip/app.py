# fastapi geo microservice using DB-IP *.mmdb (city+asn)
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
import maxminddb, ipaddress, os

CITY_DB = os.getenv("CITY_DB", "/data/dbip-city.mmdb")
ASN_DB  = os.getenv("ASN_DB",  "/data/dbip-asn.mmdb")

app = FastAPI(title="geoip", version="1.0.0")

city_reader = None
asn_reader  = None

def _open_db(path):
    return maxminddb.open_database(path) if os.path.exists(path) else None

@app.on_event("startup")
def startup():
    global city_reader, asn_reader
    city_reader = _open_db(CITY_DB)
    asn_reader  = _open_db(ASN_DB)

@app.on_event("shutdown")
def shutdown():
    for r in (city_reader, asn_reader):
        try:
            if r: r.close()
        except Exception:
            pass

@app.get("/health")
def health():
    ok = bool(city_reader)
    return {"ok": ok, "city_db": bool(city_reader), "asn_db": bool(asn_reader)}

@app.get("/lookup")
def lookup(ip: str):
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        raise HTTPException(400, "invalid ip")
    if not city_reader:
        raise HTTPException(503, "city db not loaded")

    city = city_reader.get(ip) or {}
    asn  = asn_reader.get(ip)  if asn_reader else {}

    # DB-IP uses MaxMind schema
    country      = (city.get("country") or {}).get("iso_code") or "UNKNOWN"
    country_name = (city.get("country") or {}).get("names", {}).get("en")
    region       = None
    if "subdivisions" in city and city["subdivisions"]:
        region = (city["subdivisions"][0].get("names") or {}).get("en")
    city_name    = (city.get("city") or {}).get("names", {}).get("en")
    loc          = city.get("location") or {}
    lat          = loc.get("latitude")
    lon          = loc.get("longitude")

    asn_num = asn.get("autonomous_system_number")
    as_org  = asn.get("autonomous_system_organization")

    return JSONResponse({
        "ip": ip,
        "country": country or "UNKNOWN",
        "country_name": country_name,
        "region": region,
        "city": city_name,
        "latitude": lat,
        "longitude": lon,
        "asn": asn_num,
        "as_org": as_org,
    })
