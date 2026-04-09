---
name: weather
description: Get current weather and forecasts using wttr.in (no API key required).
version: 1.0.0
metadata: '{"reese":{"tags":["weather","utility"]}}'
---

# Weather Skill

Get weather information using wttr.in — no API key needed.

## Current weather for a location
```
web_fetch("https://wttr.in/London?format=3")
```

## Detailed forecast (plain text)
```
web_fetch("https://wttr.in/Tokyo?format=v2")
```

## JSON format for parsing
```
web_fetch("https://wttr.in/Paris?format=j1")
```

## Format strings
- `%t` — temperature
- `%f` — feels like
- `%h` — humidity
- `%w` — wind
- `%c` — condition icon
- `%C` — condition text

Example: `web_fetch("https://wttr.in/NYC?format=%C+%t+feels+like+%f")`

## Tips
- Replace spaces in location names with `+` (e.g. `New+York`)
- Use airport codes for precision (e.g. `LHR`, `JFK`)
