# MMBOT

**Your Bot team, on your desktop and your phone.**

English · [中文](README.zh.md) · [Install](docs/getting-started.md) · [Download](https://github.com/lianbing22/MMBOT/releases/latest)

MMBOT connects your desktop and your phone to the Bots running on your own [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) computer or server. Chat with a specialist, bring several Bots into a group, and follow their tools and tasks from either one. The desktop app brings its own pinned DSH; the phone shares the host's conversations, models and workspace.

<p align="center">
  <img src="docs/images/mobile/home.en.png?v=0.1.0-15" width="250" alt="MMBOT conversation home">
  <img src="docs/images/mobile/chat.en.png?v=0.1.0-15" width="250" alt="A Bot conversation with floating controls">
  <img src="docs/images/mobile/night.en.png?v=0.1.0-15" width="250" alt="MMBOT in dark mode">
</p>

<p align="center">Conversation home · Bot chat · Dark mode</p>

## What you can do

The standalone desktop app imports a team from DeepSeek Harness without inheriting the old host's mobile authorization or TLS identity. Mobile access starts disabled; enable it and pair phones again. User-authored mobile skills are preserved, and the original host is unchanged.

| Feature | In the App |
| --- | --- |
| Bot team | Create and personalize Bots, choose their models, and assign Main Bots to manage the team. Each Bot keeps a long-lived conversation. |
| Group work | Bring Bots together, pick an administrator, mention a member or reference another conversation. See who is working or waiting for approval. |
| Messages and media | Stream replies and reasoning, long-press for message actions, attach images/files, and use voice input or voice chat. |
| Tools and host management | Open tool-result cards, approve or reject pending actions, manage supported Skills/plugins/connectors, and opt into desktop browser control. |
| Shared capabilities | Choose each Bot’s MCP servers, skills and capability packs configured on your DSH computer; check connection and approval status. |
| Tasks and memory | Manage scheduled tasks and Bot memory, search earlier conversations, and inspect usage from settings or details. |
| Working folders | Choose a host project or folder for a Bot, or one folder for a group. Chats continue in fresh parts while keeping their history. Available in v0.1.1 and later. |
| Notifications | Task and approval reminders with Android background reception and optional cloud push. |
| Appearance and language | Chinese/English and light/dark/system appearance. Cached conversations and drafts remain available offline. |

Scheduled tasks keep their original Session binding when a Bot's chat moves to a new part. Due reminders are forwarded to the current part; switching parts does not copy or recreate tasks.

<p align="center">
  <img src="docs/images/mobile/group.en.png?v=0.1.0-15" width="250" alt="Group conversation with Bot authors">
  <img src="docs/images/mobile/create.en.png?v=0.1.0-15" width="250" alt="Create a Bot and customize its avatar">
  <img src="docs/images/mobile/tools.en.png?v=0.1.0-15" width="250" alt="Tools, Skills and plugins">
</p>

<p align="center">Group chat · Create a Bot · Tools & skills</p>

<p align="center">
  <img src="docs/images/mobile/settings.en.png?v=0.1.0-15" width="250" alt="Settings with floating controls">
  <img src="docs/images/mobile/capabilities.en.png?v=0.1.0-15" width="250" alt="Assign MCP servers, skills and packs to each Bot">
</p>

<p align="center">Settings · Capabilities</p>

Screenshots use demonstration data. [Capture details](docs/images/mobile/README.md)

## Get started

1. Install [DSH Desktop](https://github.com/deepseek-ai/deepseek-harness/releases). Open **Plugins → Add plugin**, paste the text below, install, enable and restart.
2. Configure your model on the computer. The phone app is still named **DS Bot** in this release; the MMBOT name arrives with its next build. Download `dsbot-android-arm64-v0.1.3.apk` for phones from the [v0.1.3 Release](https://github.com/lianbing22/MMBOT/releases/tag/v0.1.3); `dsbot-android-x86_64-v0.1.3.apk` is for matching emulators.
3. Install the APK. On the computer, open MMBOT **Settings → Mobile devices → Enable phone connection**, scan its QR with the phone and approve the device.

```text
github:lianbing22/MMBOT#a115f2b722387b3a401bd34e26fe48ad7d34f78d&path:ds-bot
```

Copy the complete line. The release also includes `ds-bot-0.1.3.tgz`; verify release downloads with `SHA256SUMS`. If the pinned address cannot be installed here, for example on a computer without Git, install that archive from its full path instead. The plugin archive SHA-256 is `ab65ce3033a88890c3410c371aa7a2fc8c88f96437f4620889128b6a7b1c5b1f`.

This pin targets the released v0.1.3 source. Historical v0.1.2 downloads remain published unchanged for existing lockfiles; use v0.1.3 for new installations. See the [v0.1.3 release notes](docs/releases/v0.1.3.md).

Start on the same Wi-Fi. The plugin sets up local HTTPS without a domain or manual certificate installation. The host runs your Bots, tools and tasks using the configured model provider. Keep the computer or server online while using the App.

Use this repository's matching plugin package. The upstream npm package named `ds-bot` does not include the complete phone connection implementation.

Version 0.1.1 also supports [public IPv6 direct access](docs/mobile-local-https.md#ipv6-direct-access) across networks without a domain or relay.

iOS source is available; no IPA is currently provided. See the [iOS guide](docs/ios.md) for builds and platform support.

[Installation](docs/getting-started.md) · [Features and notifications](docs/mobile-features.zh.md) · [Remote access](docs/mobile-install.zh.md)

Host plugin upgrades and repair: [Plugin updates](docs/plugin-updates.md).

### Web search

MMBOT selects its `auto` search provider for the whole profile. If you disable `web-search-auto`, also select another registered search provider in that profile. See [Web search](ds-bot/README.md#web-search) and the [recovery steps](docs/known-issues.md#web-search-fails-everywhere-after-turning-off-web-search-auto).

## Docker

Build the image from this repository checkout; see [`docker/README.md`](docker/README.md). The container is the Bots' sandbox. Phone pairing and the mobile bridge inside Docker are not published or validated by this image.

## Desktop app

The desktop app is in [`app/`](app/README.md). It brings its own DSH, so you don't need to install DSH first. Desktop installers are attached to each MMBOT release; the carried-over `v0.1.3` release here holds the plugin archive and the phone builds, and the previous DS Bot App installers stay on the earlier repository until the first MMBOT desktop build. The names to expect, from [Releases](https://github.com/lianbing22/MMBOT/releases):

- Windows (x64): `MMBOT-<version>-win-x64.exe`. Run it; it installs for your user only, without administrator rights. If Windows shows "Windows protected your PC", select **More info** → **Run anyway**.
- macOS: `MMBOT-<version>-mac-arm64.zip` for an Apple chip, `MMBOT-<version>-mac-x64.zip` for Intel. Safari unzips it by itself; drag **MMBOT** into **Applications** and open it. When macOS says it cannot check the app, open **System Settings** → **Privacy & Security** and select **Open Anyway**.
- Linux (x64): `MMBOT-<version>-linux-x86_64.AppImage` runs on every distribution — make it executable and open it. It mounts through FUSE 2, which you may need to install first (`sudo apt install libfuse2t64` on Ubuntu 24.04+, `sudo dnf install fuse-libs` on Fedora, `sudo pacman -S fuse2` on Arch). On Ubuntu 24.04 and later an AppImage can refuse to start (Ubuntu restricts the sandbox it needs); the `MMBOT-<version>-linux-amd64.deb` on Debian/Ubuntu does not have this problem and adds a menu entry.

At the first start the app asks where to keep its data and the Bots' files, and offers to copy a Bot team from your DSH (it only reads your DSH). Set up a model in its settings. The Windows app updates itself; the macOS app and a Linux deb tell you when a new version is ready to download.

On a development machine, start it with:

```sh
cd app
npm ci
npm start
```

Build an installer with `npm run dist` on the matching target OS; native Windows, macOS and Linux packaging is left to their CI runners. macOS packages are not notarized. Desktop updater metadata is published only with a plain `vX.Y.Z` release; `-rN` revisions remain for plugin and Android assets, so a desktop update requires the next semantic version.

## Development

The App uses React Native and Expo, with a shared SDK connecting it to the DSH plugin.

| Directory | Contents |
| --- | --- |
| [apps/mobile](apps/mobile/README.md) | Mobile App, native builds and development guide |
| [packages/mobile-sdk](packages/mobile-sdk) | Phone-to-host SDK |
| [ds-bot](ds-bot/README.md) | DSH plugin, mobile bridge and computer interface |

Use Node.js 24 for development. See [Contributing](CONTRIBUTING.md) for setup, tests and contribution guidelines. [GitHub Actions](.github/workflows/build.yml) checks the plugin, desktop packages and mobile app, and builds Android APKs; signing and release steps are in the [release guide](docs/releasing.md).

The host integration baseline is DSH `0.2.1-rc.2`. Voice and desktop browser control require the corresponding host services; see [feature configuration](docs/mobile-features.zh.md).

This fork synchronizes the frozen upstream tree at `1bebe826f74e9a72cabafd3b80602b05af867b38` (upstream `v0.2.1`), whose diff base is `02cbb63a29f3591839d2b37ffa91d202a12ede6c` (upstream `v0.2.0`). This sync is unreleased here; the fork remains at `0.1.3`. Docker intentionally retains this fork's offline plugin-archive reinstall, policy metadata seeding and transactional rollback; upstream removed that behavior.

[Local debugging](docs/mobile-local-debug.zh.md) · [Upstream sync](docs/mobile-upstream.zh.md) · [Changelog](CHANGELOG.md)

## Credits and license

MMBOT is a rebranded fork of [DS Bot App](https://github.com/QingJ01/DS-Bot-App), the mobile-focused fork of [DS Bot](https://github.com/Fei2411/DeepSeek-Bot). The plugin and the desktop app ship as MMBOT; the phone app keeps its DS Bot name and package name until its next release.

The project builds on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Every Bot works in DSH Sessions and uses DSH tools and models. See [NOTICE](NOTICE) for the upstream notices.

[Apache License 2.0](LICENSE). MMBOT is an independent project, not an official DeepSeek product.
