# Cloudflare Tunnel

Expose the dashboard (and the Telegram-facing webhook-less bot stays polling, so it needs
no tunnel) without opening ports.

## Quick setup (cloudflared)

```powershell
winget install Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel create video-clipper
cloudflared tunnel route dns video-clipper clips.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: video-clipper
credentials-file: C:\Users\mzida\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: clips.example.com
    service: http://localhost:4730
  - service: http_status:404
```

```powershell
cloudflared tunnel run video-clipper
```

## Required .env changes

```env
BASE_URL=https://clips.example.com
TRUST_PROXY=true
```

- `BASE_URL` makes the session cookie `Secure` (required for HTTPS).
- `TRUST_PROXY=true` makes Express trust `X-Forwarded-For/Proto` from cloudflared.

Restart the server after changing these; existing sessions stay valid (same secret).

## Streaming notes

- Video playback uses HTTP Range requests (`/api/projects/:id/source` and
  `/api/media/:scope/:file` support them) — Cloudflare passes Range through fine.
- Uploads go through the tunnel as normal `multipart/form-data`; Cloudflare's default
  request-size limit (100 MB on the free plan) applies.

## Hardening checklist

- Keep `ADMIN_PASSWORD` strong; there is no second factor.
- Consider a Cloudflare Access policy in front of `clips.example.com` for IP-less auth.
- The health endpoint (`/api/health`) is public read-only; it leaks service versions but no data.
