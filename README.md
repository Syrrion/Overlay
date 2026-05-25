# Ura Helper

Petit overlay Electron pour partager un ordre de cinq symboles entre un leader et des viewers, avec une page web consultable par URL.

## Solution choisie

- Electron pour creer des fenetres transparentes, toujours au-dessus, sans bordure.
- `focusable: false` et `showInactive()` pour eviter que les clics overlay volent le focus de la fenetre active.
- Un relais WebSocket dedie recoit l'etat du leader, lui attribue une revision serveur et le diffuse aux viewers.
- Le leader et les viewers affichent une petite fenetre overlay de sequence, deplacable et sauvegardee localement.
- Les fenetres overlay et palette chargent directement la page web servie par le relais; le client web est donc la reference de rendu et de synchronisation.
- Le leader a en plus une palette d'icones deplacable, separee de l'affichage, elle aussi chargee depuis la page web.
- Une option permet de verrouiller le deplacement des overlays.
- Le relais sert aussi une interface web statique accessible directement depuis une URL, en mode viewer ou leader.

## Installation locale

```powershell
npm install
npm start
```

## Relais sur serveur dedie

Le serveur fourni ecoute par defaut sur le port `8787`.

```powershell
npm run relay
```

Sur Linux, par exemple:

```bash
PORT=8787 npm run relay
```

Expose ensuite ce service en WebSocket, par exemple `wss://ura.syrion.site/ws`. Si tu passes par Nginx, Caddy, Apache ou cPanel, il faut garder l'upgrade WebSocket actif vers le process Node.

Sur cPanel/02switch, il ne faut generalement pas ouvrir un port public manuel. Le relais Node doit etre lance par l'application Node.js cPanel, puis le domaine ou sous-domaine doit proxifier les requetes HTTPS normales vers la page et les upgrades WebSocket vers `/ws`. Le test attendu est:

```bash
wscat -c wss://ura.syrion.site/ws
```

Si ce test retourne une page HTTP, un code `200`, `404`, `426`, `429` ou ne declenche aucun `websocketJoins` dans `/health`, l'upgrade WebSocket est encore bloque par la couche cPanel/proxy/WAF avant d'arriver au relais Node. Le client web bascule alors sur un flux Server-Sent Events via `/api/rooms/<room>/events`, ce qui garde une diffusion temps reel compatible cPanel sans polling permanent.

## Page web

Une fois le relais lance, la page web est servie sur la meme URL HTTP.

- En local: `http://127.0.0.1:8787/`
- Derriere ton domaine: `https://ton-domaine/`

Par defaut, la page web se connecte au meme host en WebSocket et rejoint le salon `ura-helper`.

Parametres utiles:

- `?room=autre-salon` pour consulter un autre salon
- `?relay=wss://ura.syrion.site/ws` si la page statique est hebergee ailleurs que le relais
- `?mode=leader` pour piloter la sequence depuis le navigateur
- `?view=overlay` pour charger la vue compacte d'affichage utilisee par Electron
- `?view=palette&mode=leader` pour charger la palette compacte utilisee par Electron

Exemples:

- `https://ton-domaine/?room=raid-alpha`
- `https://viewer.ton-domaine/?room=raid-alpha&relay=wss://ura.syrion.site`
- `https://ton-domaine/?mode=leader&room=raid-alpha`
- `https://ton-domaine/?view=overlay&room=raid-alpha`

## Utilisation

1. Lancer l'app avec `npm start`.
2. Choisir `Leader` ou `Viewer`.
3. Le leader choisit `Lancer en Leader`; les autres choisissent `Lancer en Viewer`.
4. La fenetre de controle se masque apres demarrage. `Ctrl+Shift+O` la fait reapparaitre.
5. Deplacer les overlays en tirant la poignee ou le fond de la petite fenetre, puis activer `Verrouiller le deplacement` si besoin.
6. Quand les cinq symboles sont definis, ils restent visibles 20 secondes, puis s'effacent automatiquement partout.
7. Pour un viewer sans client lourd, ouvrir l'URL du relais dans un navigateur.

## Notes importantes

- Pour les jeux, utiliser de preference le mode fenetre sans bordure. Certains jeux en plein ecran exclusif DirectX peuvent rester au-dessus de tout overlay desktop.
- Le relais fourni ne gere pas encore d'authentification. Si tu l'exposes publiquement, ajoute un token ou filtre l'acces au niveau du proxy.
- Les positions des overlays sont sauvegardees dans les donnees utilisateur de l'application.
- Les etats publies portent un identifiant de source et une revision serveur pour eviter qu'une reponse HTTP ou WebSocket plus ancienne ecrase un etat recent.

## Verification rapide

```powershell
npm run check
```
