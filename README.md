# Ashgrove Electricity Hub

Agile Import Advisor: shows Octopus Agile import prices alongside the next day's weather and recommends the best times to import electricity. It covers the cheapest windows, plunge pricing, a battery charging plan and a solar estimate. It can also show **live figures from your SolaX system**: solar, battery %, house use, and grid import/export.

- Prices: Octopus Energy public API (Agile, inc. VAT)
- Weather: Open-Meteo
- Postcode lookup: postcodes.io
- Live system: SolaX Developer OpenAPI (Client ID / Client Secret)

## Hosting on Render

Create a **Web Service** from this repo:

| Setting | Value |
|---|---|
| Runtime | Node |
| Build command | `npm install` |
| Start command | `node server.js` |
| Instance type | Free |

### Environment variables (Render → your service → Environment)

| Key | Required | Value |
|---|---|---|
| `SOLAX_CLIENT_ID` | for live data | Client ID from developer.solaxcloud.com → Application → Authorization |
| `SOLAX_CLIENT_SECRET` | for live data | Client Secret from the same page |
| `ACCESS_PASSWORD` | recommended | Password to view the site (any username works) |
| `SOLAX_BASE_URL` | no | Defaults to `https://openapi-eu.solaxcloud.com` |
| `SOLAX_INVERT_GRID` | no | Set to `1` if import/export show the wrong way round |
| `SOLAX_INVERT_BATTERY` | no | Set to `1` if charging/discharging show the wrong way round |

Your plant, inverter and battery are found automatically, so no serial numbers are needed. The SolaX application only needs the **Data Monitoring** (`API_Telemetry_V2`) and **Information Access** (`API_Info_V2`) services.

Never commit the secret to this repo.

To troubleshoot, open `/api/solax/raw` on the site to see the unprocessed SolaX response.

## Running locally

```
node server.js
```

Then open http://localhost:3000. Set the environment variables first for live data.
