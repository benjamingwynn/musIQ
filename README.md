# musIQ

Experimental asynchronous in-browser engine for powering musical visualizers, detecting various musical components through a combination of traditional audio analysis and machine learning.

Detects the following musical features:

- Section positions
- Section loudness
- Section bpm
- Section keys
- Beat positions
- Segment loudness
- Tatum positions (experimental)
- Various technical segment features such as ZCR

This can be used as an in-browser replacement for Spotify's Audio Analysis API or other SaSS products for audio analysis, assuming you have the file available to the browser.

Underneath it's powered by tensorflow.js for AI models and [aubiojs](https://github.com/qiuxiang/aubiojs) in a web worker for beat detection.

This repo includes the trained models, typescript declarations and Javascript code to run the engine.

If you have setup frontend bundling, install `@benjamingwynn/musiq` and import `makeAnalyser` to begin.

## Compatibility

- Works well in Chromium based browsers.
- Very slow in Safari, needs further investigation.
- Unreliable and slow in Firefox requiring a hack.
