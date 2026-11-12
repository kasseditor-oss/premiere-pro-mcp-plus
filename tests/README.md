# Tests

- `npm test` - ES3 syntax check of the host library, panel syntax check, MCP stdio smoke test.
- `node tests/e2e-premiere.mjs <folder>` - live test against a running Premiere Pro (includes one test per item of each bug report).
- `node tests/e2e-bugfixes.mjs [folder]` - regression test for the first bug report.
- Close other projects in Premiere before running them: with several projects open, scripts can act on the wrong one.

Generate the media for the live test (FFmpeg):

```bash
ffmpeg -f lavfi -i testsrc2=size=1920x1080:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 12 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest clipA.mp4
ffmpeg -f lavfi -i mandelbrot=size=1280x720:rate=24 -f lavfi -i sine=frequency=220:sample_rate=48000 -t 10 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest clipB.mp4
ffmpeg -f lavfi -i color=c=0x2266ff:size=1920x1080 -frames:v 1 still.png
ffmpeg -f lavfi -i sine=frequency=330:sample_rate=48000 -af volume=0.3 -t 15 vo.wav
ffmpeg -f lavfi -i anoisesrc=d=2:c=pink:a=0.3 -f lavfi -i anullsrc=r=48000:cl=stereo -filter_complex "[0][1]concat=n=2:v=0:a=1,atrim=0:4" talk.wav
printf '1\n00:00:00,500 --> 00:00:02,000\nOla mundo\n' > subs.srt
```
