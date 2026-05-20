# Ura Helper

Petit overlay Electron pour partager un ordre de cinq symboles entre un leader et des viewers, avec un viewer web consultable par URL.

## Solution choisie

- Electron pour creer des fenetres transparentes, toujours au-dessus, sans bordure.
- `focusable: false` et `showInactive()` pour eviter que les clics overlay volent le focus de la fenetre active.
- Un relais WebSocket dedie recoit l'etat du leader et le diffuse aux viewers via une configuration integree non exposee dans l'interface.
- Le leader et les viewers affichent une petite fenetre overlay de sequence, deplacable et sauvegardee localement.
- Le leader a en plus une palette d'icones deplacable, separee de l'affichage.
- Une option permet de verrouiller le deplacement des overlays.
- Le relais sert aussi une interface web viewer statique accessible directement depuis une URL.

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

Expose ensuite ce service en WebSocket, par exemple `wss://ura.syrion.site`. Si tu passes par Nginx ou Caddy, il faut garder l'upgrade WebSocket actif vers le port du relais.

## Viewer web

Une fois le relais lance, le viewer web est servi sur la meme URL HTTP.

- En local: `http://127.0.0.1:8787/`
- Derriere ton domaine: `https://ton-domaine/`

Par defaut, la page web se connecte au meme host en WebSocket et rejoint le salon `ura-helper`.

Parametres utiles:

- `?room=autre-salon` pour consulter un autre salon
- `?relay=wss://ura.syrion.site` si la page statique est hebergee ailleurs que le relais

Exemples:

- `https://ton-domaine/?room=raid-alpha`
- `https://viewer.ton-domaine/?room=raid-alpha&relay=wss://ura.syrion.site`

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
- Le viewer web est volontairement consultatif. Le pilotage Leader reste dans le client lourd pour l'instant.

## Verification rapide

```powershell
npm run check
```
