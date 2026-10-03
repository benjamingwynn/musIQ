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

Underneath it's powered by [aubiojs](https://github.com/qiuxiang/aubiojs) in a web worker.
