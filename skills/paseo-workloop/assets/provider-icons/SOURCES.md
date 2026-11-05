The Devin, OpenAI (used for Codex) and DeepSeek SVGs are from Lobe Icons v1.102.0:
https://github.com/lobehub/lobe-icons (MIT; see LOBE-LICENSE.txt).
The Pi SVG is https://pi.dev/logo-auto.svg, linked as the Pi logo in
https://github.com/earendil-works/pi/tree/main/packages/coding-agent.
These identify the respective products; their marks belong to their owners.

The PNG frames are generated from these SVGs by
`scripts/build-provider-icons.mjs`. Install `@resvg/resvg-js` separately and
set `RESVG_MODULE` to its absolute module path to regenerate them. Neither
the renderer nor a network connection is required when running an agent.
