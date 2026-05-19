<p align="center">
  <img src="public/logo.png" alt="Tracker Dashboard" width="260">
</p>

> **Tu l'utilises ? Tu l'aimes ? [⭐ Mets une étoile !](https://github.com/Aerya/tracker-dashboard/stargazers)** — ça prend deux secondes.

> [!WARNING]
> Lors d’un rafraîchissement général ou du premier lancement, certains trackers peuvent temporairement afficher une erreur ou prendre du temps à se mettre à jour.
>
> Si besoin, lancez une mise à jour individuelle du tracker concerné.
>
> Un goulot d’étranglement existe actuellement au niveau du navigateur headless intégré. Ce point sera retravaillé dans une prochaine version (ou pas).



# Tracker Dashboard

Tracker Dashboard est une WebUI pour suivre les statistiques de trackers BitTorrent : upload, download, ratio, buffer, points bonus, torrents en seed, selon les fonctionnalités du tracker.
Le projet permet de configurer les trackers actifs, leurs identifiants, un proxy HTTP/HTTPS/SOCKS, des connexions automatiques espacées dans le temps et l'historique des statistiques en SQLite.

Au premier accès, l'application demande de créer le compte administrateur de la WebUI.


## Changements récents

- Nostradamus passe en tracker Ratioless : les cartes affichent désormais **Points** et **Taux** à la place de Seeding et Bonus. Download, Upload, Ratio (calculé) et Buffer (calculé) restent inchangés.
- HD-Only marqué comme Ratioless : un badge **Ratioless** apparaît sur les cartes HD-Only et Nostradamus, entre le nom du tracker et le bouton MàJ.
- Image Docker buildée en multi-architecture (linux/amd64 + linux/arm64) via QEMU.
- Mise en place de Dependabot pour npm, Docker et GitHub Actions, avec auto-merge des patches via workflow GitHub Actions.
- Pin de l'image de base à `node:22.15.0-bookworm-slim` et bump des GitHub Actions vers les versions Node 24.
- Bump des dépendances npm : Express 5, TypeScript 6, @types/node 25, axios 1.16, tsx 4.22.


## Captures d'écran

Les captures ci-dessous montrent l'interface avec des données issues du mode Présentation. Les valeurs affichées sont factices et ne reflètent pas des statistiques réelles.

![Dashboard](screens/1.png)

![Configuration des trackers](screens/2.png)

![Proxy et options](screens/3.png)


## Fonctionnement général

L'application lit les définitions disponibles dans `config/trackers/*.json` et les ajoutent à une liste de tracker BitTorrent disponibles pour la configuration.
Chaque définition indique comment se connecter au site, quelle page lire et quelles valeurs extraire.

Depuis la WebUI, on peut :

- activer ou retirer un tracker,
- enregistrer ou réinitialiser les identifiants d'un tracker,
- configurer un proxy HTTP, HTTPS, SOCKS4 ou SOCKS5,
- autoriser explicitement la connexion directe sans proxy si ce Docker passe par un VPN (ou si vous aimez sortir à poual, ce qui est fortément déconseillé),
- lancer un rafraîchissement manuel des statistiques,
- activer une connexion automatique par tracker,
- lui choisir un intervalle : 24h, 48h, 7 jours ou 21 jours.

Les données persistantes sont stockées dans SQLite, dans le volume `config` monté.


## Sécurité proxy

Par défaut, les connexions aux trackers sont bloquées si aucun proxy n'est actif.
Pour autoriser les connexions, il faut soit :
- configurer et activer un proxy,
- cocher explicitement l'option de connexion directe sans proxy.
Cette sécurité s'applique aussi au premier lancement du conteneur.


## User-Agent aléatoire

Les connexions utilisent une rotation automatique de User-Agents issue du paquet `top-user-agents`. Il est choisi automatiquement pour les nouvelles sessions HTTP et les nouveaux contextes navigateur.


## Connexions automatiques

Chaque tracker peut avoir sa propre planification automatique.
La WebUI permet de choisir 24h/48h/7j/21j.
L'application calcule ensuite une prochaine exécution pour chaque tracker. Le bouton `Rafraîchir les statistiques` permet de lancer un rafraîchissement manuel.


## Sites intégrés

Les définitions de sites déjà fournies sont disponibles directement dans :

```text
config/trackers/
```

Chaque fichier JSON correspond à un site et contient sa configuration de connexion, la page à lire et les champs à extraire.

N'hésitez pas à me partager vos définitions, que je les ajoute au Docker.


## Ajouter un nouveau site

Pour ajouter un tracker, il faut créer un fichier JSON dans :

```text
config/trackers/
```

Pour préparer l'ajout d'un site, il faut idéalement fournir :
- le nom du site,
- l'URL de base du site,
- l'URL de la page de login,
- la méthode de login si elle est particulière (combinaison de touches pour accéder au login etc),
- l'URL de la page qui contient les statistiques du compte,
- le code source HTML de cette page une fois connecté,
- les noms exacts des valeurs à récupérer : upload, download, ratio, bonus, buffer, seeding, etc,
- si le site utilise un CMS connu, par exemple UNIT3D, Gazelle, Luminance...

Les champs habituellement exploités par le tableau de bord sont :

| Champ | Usage |
|---|---|
| `uploadedBytes` | Upload |
| `downloadedBytes` | Download |
| `ratio` | Ratio |
| `bufferBytes` | Buffer |
| `seeding` | Torrents en seed |
| `seedBonus` | Points bonus |
| `tokens` | Jetons ou tokens |

Si le ratio n'est pas présent sur le site mais que l'upload et le download sont disponibles, le tableau de bord peut le calculer.
Si le buffer n'est pas fourni par le site, il peut être calculé à partir de l'upload et du download.


## Format simplifié d'une définition

Exemple schématique :

```json
{
  "id": "example",
  "name": "Example Tracker",
  "baseUrl": "https://example.org",
  "enabled": false,
  "login": {
    "url": "login",
    "method": "POST",
    "contentType": "form",
    "body": {
      "username": "{{username}}",
      "password": "{{password}}"
    },
    "failurePatterns": ["login"]
  },
  "fetch": {
    "url": "account",
    "mode": "http",
    "responseType": "html",
    "fields": {
      "uploadedBytes": {
        "regex": "Upload[^0-9]*(?<value>[0-9.,]+\\s*(?:GB|GiB|TB|TiB))",
        "transform": "bytes"
      }
    }
  }
}
```


## Transformations disponibles

| Transformation | Effet |
|---|---|
| `bytes` | Convertit une taille comme `1.5 GB`, `800 MiB`, `2 To`, `276 Gio` en nombre d'octets |
| `number` | Convertit en nombre décimal |
| `integer` | Convertit en entier |
| `string` | Conserve la valeur en texte |
