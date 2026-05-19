# Render Service Deploy

## Coolify

1. Create a new application from the GitHub repository.
2. Use Dockerfile build pack.
3. Set the exposed port to `3001`.
4. Add environment variables:

```env
PORT=3001
RENDER_API_KEY=change-me
OUTPUT_TTL_HOURS=24
CLEANUP_HOUR=1
```

## Checks

Health:

```bash
curl https://your-domain/health
```

Templates:

```bash
curl https://your-domain/templates -H "x-api-key: change-me"
```

Render:

```bash
curl https://your-domain/render \
  -H "content-type: application/json" \
  -H "x-api-key: change-me" \
  --data-binary @examples/make-request.json
```

## Make HTTP Module

```text
Method: POST
URL: https://your-domain/render
Headers:
  Content-Type: application/json
  x-api-key: your-secret-key
Body type: Raw
Content type: JSON
Parse response: Yes
```
