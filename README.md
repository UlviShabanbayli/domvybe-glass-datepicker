# Glass date-range picker — UI component

**[Live demo](https://domvybe.com/components/glass-datepicker/)** · [Step-by-step tutorial](https://domvybe.com/library/glass-datepicker/) · [Download the ZIP](https://github.com/UlviShabanbayli/domvybe-glass-datepicker/releases/latest/download/glass-datepicker-source.zip)

Glass month panes over a sunset: pick two dates and molten amber pours from a glass tube through every day of the range, turning at each week like water.

Open `index.html` through any local static server (for example `python3 -m http.server`) and try it with a mouse,
a finger or the keyboard. Plain HTML, CSS and JavaScript; no build step, no libraries.

- `index.html` — the picker page: the month panes, the weekday rows, the range summary and the live region
- `css` — app.css: the panes, the day tiles, the range states, the frosted fallback without WebGL 2, the phone layout, reduced motion
- `js` — app.js (state, the ARIA grid, keys, click, tap and drag ranges, swipe between months), cal.js (calendar maths and labels), glass.js (the WebGL 2 panes, tube and molten ribbon)
- `img` — the sunset photo (AI-generated with Google Gemini) in WebP at three sizes, and manifest.js

The sunset photo was AI-generated (Google Gemini); the glass month panes, the tiles, the tube and the molten ribbon are
made in code (one WebGL 2 canvas + HTML, CSS and JavaScript). The calendar is a real ARIA grid with keys; `?today=`
sets the day it opens on, and without WebGL 2 (or with `?nogl`) the panes are frosted CSS glass. The page reads Google
Fonts (Inter).

It respects `prefers-reduced-motion`. Made by Ulvi (Code with Ulvi) · domvybe.com

## Licence

MIT — see [LICENSE](LICENSE). Use it in your own projects, commercial ones included.
