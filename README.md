<p align="center">
  <img src="https://addons.mozilla.org/user-media/addon_icons/3094/3094265-64.png?modified=d6b8385a" alt="SubBridge logo" width="96">
</p>

<h1 align="center">SubBridge</h1>

<p align="center">
  <strong>Translate video subtitles directly in your browser.</strong>
</p>

<p align="center">
  <a href="https://addons.mozilla.org/firefox/addon/subbridge/"><img src="https://img.shields.io/badge/Firefox-Extension-FF7139?logo=firefoxbrowser&logoColor=white" alt="Firefox Extension"></a>  <a href="https://github.com/KerimDemirkaynak/SubBridge/releases/"><img src="https://img.shields.io/github/v/release/KerimDemirkaynak/SubBridge?label=Version&color=blue" alt="Version"></a> <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License"></a>
</p>

SubBridge translates subtitles displayed on supported video websites into your preferred language. Watch anime, movies, and other videos while following translated subtitles without leaving the page.

It works with existing video subtitles, such as those enabled on YouTube or displayed on other supported streaming websites. You can use traditional machine translation or choose an AI-powered translation service.

## Features

* **Real-time subtitle translation** — Translate existing subtitles while watching videos on supported websites.
* **Multiple translation providers** — Use Google Translate, DeepL, or supported AI services.
* **AI-powered translation** — Optionally use models from providers such as OpenAI, Google Gemini, Anthropic Claude, DeepSeek, OpenRouter, and others.
* **40 languages** — Choose your preferred source and target languages.
* **Customizable appearance** — Adjust how translated subtitles look on screen.
* **Translation glossary** — Configure preferred translations for names and terminology with compatible AI providers.
* **Context-aware translation** — Supply additional subtitle context to supported AI models for more consistent translations.
* **Custom API endpoints** — Configure compatible translation APIs and local AI services.
* **Flexible settings** — Customize translation behavior and other available options.

## Screenshots

### Translated subtitles

See how translated subtitles appear over a video.

<p align="left">
  <img src="https://addons.mozilla.org/user-media/previews/thumbs/424/424446.jpg?modified=1791832725" alt="Translated subtitles and their appearance" width="500">
</p>

### User interface

The SubBridge interface and its available controls.

<p align="left">
  <img src="https://addons.mozilla.org/user-media/previews/full/424/424447.png?modified=1791832716" alt="SubBridge user interface" width="200">
</p>

## Translation Providers

SubBridge supports Google Translate, DeepL, and various AI translation providers. You can select a service according to your preferences and configure API access where required.

Some providers require an API key and may charge for usage. Availability, pricing, and rate limits depend on the selected provider.

## Privacy

SubBridge processes video pages to detect and translate existing subtitles. Depending on the selected translation provider, subtitle text may be sent to an external service for translation.

Please review the privacy policy of your chosen provider before using it.

## License

SubBridge is licensed under the [MIT License](LICENSE).

## Crunchyroll

1. Build/install SubBridge, then reload the Crunchyroll watch page so the page hook is present before the player starts.
2. Choose a translation provider and target language. Set **From** to the subtitle language you want to translate, or choose **Auto**.
3. Start translation from the extension popup, the floating video button, or **Alt+R**. **Alt+D** shows/hides the original line; **Alt+R** stops translation and restores the player's captions.

SubBridge reads the subtitle and closed-caption URLs in Crunchyroll's playback metadata. For dubs, Auto prefers closed captions in the audio language; otherwise it prefers English when available, then the first available locale. Matching subtitle/sign and closed-caption files are combined. Selecting a source language that has no subtitle track reports an error instead of translating a different language.

The adapter supports ASS/SSA, WebVTT and SRT text tracks, including player frames on Crunchyroll subdomains. It does not transcribe audio or remove text burned into the video. Translated ASS text uses SubBridge's subtitle styles; complex ASS typesetting, vector drawings and animations are not reproduced. Other DRM sites are not implied to be supported.

[SubTranslate](https://github.com/YabQ/SubTranslate) was consulted to confirm the playback response shape. The adapter is independently implemented and does not include SubTranslate source code; SubBridge retains its MIT license.

## Development and installation

Requires Node.js 20+ and Python 3. Node dependencies are used only for tests and are not shipped in the extension.

```sh
npm ci --ignore-scripts
npm test
python3 build.py
npm run check
```

The build produces:

- `dist/chrome/` and `dist/subbridge-chrome.zip`: load the unpacked directory from `chrome://extensions` with Developer mode enabled.
- `dist/firefox/` and `dist/subbridge-firefox.xpi`: for local testing, load `dist/firefox/manifest.json` through `about:debugging` → This Firefox → Load Temporary Add-on. Normal Firefox installation requires an AMO-signed package. Minimum Firefox version: 142.

CI runs the regression tests and validates both manifests before uploading the two packages as the `subbridge-extensions` artifact. See [CHANGELOG.md](CHANGELOG.md) for fixes and test limitations. Authenticated Crunchyroll playback still needs an end-to-end check with a permitted account; automated tests use local fixtures and mocked APIs.
