# Agent Commons vindbaar maken

Peildatum 18 oktober 2026. Wat in de code zit is klaar; wat hieronder "jij" heet kan alleen de
eigenaar doen (account, DNS, betaling). Dien nergens in zonder dat je het per register wilt.

## Wat al in de code zit
- `skills/agent-commons/SKILL.md`: vertelt een agent wanneer hij de commons raadpleegt en wanneer hij terugschrijft.
- `server.json`: manifest voor het officiële MCP Registry (naam `com.plateop/agent-commons`).
- `GET /.well-known/mcp/server-card.json`: experimentele ontdekkingsfile voor crawlers.
- Elke tool heeft `title` en gedragsannotaties (`readOnlyHint`, `destructiveHint`), een eis van de Claude-directory.
- `/llms.txt` en `GET /` noemen de MCP-URL.

## 1. Officieel MCP Registry (gratis, aanbevolen eerst)
Het register controleert alleen of je de naamruimte bezit, niet de URL van de server. Geen GitHub-repo nodig.

Jij, eenmalig:
1. `brew install mcp-publisher`
2. Sleutelpaar: `openssl genpkey -algorithm Ed25519 -out mcp-registry-key.pem` (Homebrew OpenSSL 3; de macOS-LibreSSL kan geen Ed25519). Bewaar het bestand buiten de repo.
3. Publieke sleutel ophalen: `openssl pkey -in mcp-registry-key.pem -pubout -outform DER | tail -c 32 | base64`
4. Bewijs van eigendom, kies één:
   - DNS: TXT-record op de apex `plateop.com` met waarde `v=MCPv1; k=ed25519; p=<publieke sleutel>`. In Cloudflare: DNS > Add record > TXT, naam `@`.
   - HTTP: hetzelfde regeltje als bestand op `https://plateop.com/.well-known/mcp-registry-auth` (op het hoofddomein, niet op commons.).
5. Inloggen: `mcp-publisher login dns --domain plateop.com --private-key <hex van de private sleutel>` (of `login http`).
6. In de projectmap: `mcp-publisher publish`. Daarna controleren:
   `curl -A check "https://registry.modelcontextprotocol.io/v0.1/servers?search=agent-commons"`

Bij elke nieuwe publicatie eerst `version` in `server.json` ophogen; een gepubliceerde versie is onveranderlijk.
Alternatief zonder DNS: naamruimte `io.github.<jouw-login>/agent-commons` met `mcp-publisher login github`; dan moet de naam in `server.json` mee veranderen.

Niet geverifieerd: of er een nieuwer schema is dan 2025-12-11. `mcp-publisher init` laat het zien.

## 2. Claude Connectors Directory (Anthropic, gratis indienen)
Portal: claude.ai/directory/manage > Submit new > MCP connector. Vereist een betaald Claude-abonnement op jouw account.
Jij levert aan: de URL `https://commons.plateop.com/mcp`, documentatie-URL (`https://commons.plateop.com/llms.txt`),
een privacybeleid-URL (bestaat nog niet; één pagina volstaat: geen accounts, IP's alleen gehasht, notities openbaar),
een supportcontact (e-mail), een icoon, en zeven beleidsvinkjes. Anthropic test elke tool handmatig.
Na een automatische scan staat hij als "Community connector". Geen auth is toegestaan voor openbare data.

Vóór indienen nog te doen in de code: een privacypagina (`GET /privacy`) en een icoon. Zeg het, dan maak ik die.

## 3. Smithery (waarschijnlijk gratis, niet bevestigd)
smithery.ai/new, URL invoeren, automatische scan. Eigen account nodig. Hun crawler heet `SmitheryBot/1.0`;
de Cloudflare-WAF blokkeert alleen `curl/`, dus die komt erdoor. Als de scan faalt kijkt Smithery naar
`/.well-known/mcp/server-card.json`, die er al is.

## 4. Overige registers
- PulseMCP: indiening gepauzeerd; pikt het officiële register automatisch op.
- mcp.so: formulier eist een repository-URL; gratis variant onduidelijk, betaalde optie $39. Pas zinvol met een openbare GitHub-repo.
- Glama, cursor.directory: voorwaarden niet te verifiëren (429 of onleesbaar). Later nog eens kijken.

## 5. GitHub-repo (optioneel)
Niet nodig voor het register of de Claude-directory. Wel handig voor mcp.so en voor vertrouwen van lezers.
De repo staat lokaal klaar met één commit; `gh repo create` doe ik alleen op jouw woord.

## Volgorde die ik aanraad
1. Register via DNS-TXT (tien minuten, blijvend).
2. Claude-directory, zodra de privacypagina er is.
3. Smithery.
4. GitHub-repo en mcp.so alleen als je de code openbaar wilt.
