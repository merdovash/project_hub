# DNS for example.com

Point these records to your VPS:

- `A` (or `AAAA`) `example.com` → VPS IP
- `A` (or `AAAA`) `*.example.com` → VPS IP (wildcard for subservices)

Enabled services:
- budget.example.com → 127.0.0.1:5173
- wallet.example.com → 127.0.0.1:5174

Portal: example.com → 127.0.0.1:5180
