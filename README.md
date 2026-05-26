# Ura Helper

Petit overlay Electron pour partager un ordre de cinq symboles entre un leader et des viewers, avec une page web consultable par URL.

## Solution choisie

- Electron pour creer des fenetres transparentes, toujours au-dessus, sans bordure.
- `focusable: false` et `showInactive()` pour eviter que les clics overlay volent le focus de la fenetre active.
- Un relais HTTP recoit les actions du leader, leur attribue une revision serveur et diffuse l'etat aux viewers par Server-Sent Events.
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

## Build Windows

Pour produire l'exécutable portable Windows et le publier dans les fichiers statiques du site:

```powershell
npm run build:publish
```

Le fichier servi au téléchargement web est ensuite disponible dans `server/public/downloads/Ura-Helper-windows-x64-portable.exe`.

## Build macOS

Pour produire l'image disque macOS (`.dmg`) et la publier dans les fichiers statiques du site:

```powershell
npm run build:publish:mac
```

En build local sur macOS, le fichier publie est disponible dans `server/public/downloads/` sous le nom suivant:

- `Ura-Helper-macos-arm64.dmg`

Attention: `electron-builder` ne peut pas produire les artefacts macOS depuis Windows. Si tu n'as pas de Mac, utilise le workflow GitHub Actions du depot. Il lance `npm run build:mac` sur `macos-latest`, puis commit automatiquement `server/public/downloads/Ura-Helper-macos-arm64.dmg` sur la branche par defaut. La page web peut ensuite pointer directement vers GitHub pour ce fichier.

Comme le fichier depasse 100 Mo, le depot doit avoir Git LFS actif pour `server/public/downloads/Ura-Helper-macos-arm64.dmg`.

Le workflow est defini dans `.github/workflows/build-macos.yml` et peut etre lance manuellement depuis l'onglet Actions. Sur `push` vers `main`, le build macOS n'est lance que si le client lourd a change (`src/`, `package.json`, `package-lock.json`, `scripts/publish-build.js`). Si le push ne touche que la partie web ou seulement la CI, le build macOS est ignore.

## Deploiement automatique o2switch

Le workflow GitHub Actions peut deployer automatiquement apres chaque push sur `main`.

Prerequis cote o2switch:

- acces SSH actif
- depot Git deja clone sur le serveur
- application Node.js cPanel/Passenger configuree

Secrets GitHub a definir:

- `O2SWITCH_SSH_HOST`: host SSH o2switch
- `O2SWITCH_SSH_PORT`: port SSH o2switch
- `O2SWITCH_SSH_USER`: utilisateur SSH
- `O2SWITCH_SSH_PRIVATE_KEY`: cle privee autorisee sur le serveur
- `O2SWITCH_REPO_PATH`: chemin absolu du depot clone sur le serveur
- `O2SWITCH_PASSENGER_APP_PATH`: chemin absolu de l'application Node.js cPanel (celui qui contient `tmp/restart.txt`)

Le deploiement automatique execute ensuite:

- `git fetch`, `git checkout`, `git pull --ff-only`
- `npm ci --omit=dev`
- creation de `tmp/restart.txt` pour forcer le redemarrage Passenger/Node.js

Si le job `deploy-o2switch` echoue des l'etape SSH, le workflow verifie maintenant explicitement que tous les secrets sont definis et que la cle privee SSH est lisible. Le secret `O2SWITCH_SSH_PRIVATE_KEY` peut contenir soit la cle privee complete, soit la cle privee encodee en base64. Si `ssh-keygen` echoue, le secret est invalide ou tronque. Si `ssh-keyscan` echoue, le host, le port ou l'acces SSH est incorrect.

## Relais sur serveur dedie

Le serveur fourni ecoute par defaut sur le port `8787`.

```powershell
npm run relay
```

Sur Linux, par exemple:

```bash
PORT=8787 npm run relay
```

Expose ensuite ce service en HTTPS normal. Sur cPanel/02switch, le relais Node doit etre lance par l'application Node.js cPanel; aucune ouverture de port public manuel n'est necessaire.

La diffusion temps reel utilise Server-Sent Events via `/api/rooms/<room>/events`. Le test attendu est:

```bash
curl -N https://ura.syrion.site/api/rooms/ura-helper/events
```

La commande doit afficher un premier bloc `event: state` et rester ouverte. Les actions leader sont envoyees en `POST` sur `/api/rooms/<room>/state`.

## Page web

Une fois le relais lance, la page web est servie sur la meme URL HTTP.

- En local: `http://127.0.0.1:8787/`
- Derriere ton domaine: `https://ton-domaine/`

Par defaut, la page web ouvre le flux temps reel du meme host et rejoint le salon `ura-helper`.

Parametres utiles:

- `?room=autre-salon` pour consulter un autre salon
- `?relay=https://ura.syrion.site` si la page statique est hebergee ailleurs que le relais
- `?mode=leader` pour piloter la sequence depuis le navigateur
- `?view=overlay` pour charger la vue compacte d'affichage utilisee par Electron
- `?view=palette&mode=leader` pour charger la palette compacte utilisee par Electron

Exemples:

- `https://ton-domaine/?room=raid-alpha`
- `https://viewer.ton-domaine/?room=raid-alpha&relay=https://ura.syrion.site`
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
- Les etats publies portent un identifiant de source et une revision serveur pour eviter qu'une reponse plus ancienne ecrase un etat recent.

## Verification rapide

```powershell
npm run check
```
