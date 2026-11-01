// Loads Mediabunny (https://mediabunny.dev, MPL-2.0) and its AC-3/E-AC-3 decoder for converting files in the browser.
import * as Mediabunny from './mediabunny.module.js';
import { registerAc3Decoder } from './mediabunny-ac3.module.js';
registerAc3Decoder();
window.Mediabunny = Mediabunny;
window.dispatchEvent(new Event('mediabunny-ready'));
