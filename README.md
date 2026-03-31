# personal_dashboard
Single-page web app designed as a personal dashboard.  Created as a labor of love from a flat .html file I used to maintain manually and with the help of Claude.ai.  I am putting it here to allow folks to use it.  It does not save your bookmark links for anyone else to see, as it stores them in browser storage.  It does have the ability to import from browser backup and to save/load personal settings and links to a .json file.  This lets you store a backup of your links and whatnot, as well as to open them across browsers and on different devices.

## Usage

This project is shared publicly for use and reference only.

You may view and interact with the hosted version, but the source code is not licensed for reuse, modification, or distribution.

## pollen-proxy-worker.js

This is a ready-made Cloudflare worker that, when deployed, can be pointed to in the config so certain widgets can function properly.  Primarily a tool to get around CORs restrictions with some of the API calls needed to do things like get pollen level data for the weather widgets.
