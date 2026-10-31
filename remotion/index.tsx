/* Remotion entry: registers the transparent CaptionOverlay and CreativeOverlay
   compositions. Width/height/fps/duration come from inputProps via
   calculateMetadata so the same compositions serve final (1080x1920) and
   preview (540x960) renders. WatermarkRaster renders sanitized SVG watermarks
   to a transparent PNG still. */
import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { CaptionOverlay, type CaptionOverlayProps } from './CaptionOverlay';
import { CreativeOverlay, type CreativeOverlayProps } from './CreativeOverlay';
import { WatermarkRaster, type WatermarkRasterProps } from './WatermarkRaster';

const demoProps: CaptionOverlayProps = {
  width: 1080,
  height: 1920,
  fps: 30,
  durationInFrames: 90,
  events: [
    {
      start: 0.5,
      end: 2.5,
      lines: ['This is what our', 'remotion captions look like'],
      words: null,
      emphasisWords: ['remotion'],
    },
  ],
  preset: {
    font: 'Arial Black', font_size: 64, position: 'bottom', margin_v: 220,
    primary_color: '#FFFFFF', outline_color: '#000000', outline_width: 4,
    bold: true, uppercase: false, karaoke: true, karaoke_color: '#FF3D00', animation: 'none',
  },
  emphasis: { enabled: true, color: '#FFD400', scale_percent: 118, bold: true },
  mode: 'ai',
  animations: true,
};

const rasterProps: WatermarkRasterProps = { dataUri: '', width: 512, height: 512 };

const creativeProps: CreativeOverlayProps = {
  width: 1080,
  height: 1920,
  fps: 30,
  durationInFrames: 90,
  captions: null,
  graphics: {
    accentColor: '#FFD400',
    progressBar: true,
    titles: [{ text: 'Adaptive overlay', sub: 'demo', start: 0.2, end: 2.5, position: 'center' }],
    lowerThirds: [],
    statCards: [],
    callouts: [],
  },
};

const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="CaptionOverlay"
      component={CaptionOverlay}
      durationInFrames={demoProps.durationInFrames}
      fps={demoProps.fps}
      width={demoProps.width}
      height={demoProps.height}
      defaultProps={demoProps}
      calculateMetadata={({ props }) => ({
        durationInFrames: props.durationInFrames,
        fps: props.fps,
        width: props.width,
        height: props.height,
      })}
    />
    <Composition
      id="CreativeOverlay"
      component={CreativeOverlay}
      durationInFrames={creativeProps.durationInFrames}
      fps={creativeProps.fps}
      width={creativeProps.width}
      height={creativeProps.height}
      defaultProps={creativeProps}
      calculateMetadata={({ props }) => ({
        durationInFrames: props.durationInFrames,
        fps: props.fps,
        width: props.width,
        height: props.height,
      })}
    />
    <Composition
      id="WatermarkRaster"
      component={WatermarkRaster}
      durationInFrames={1}
      fps={1}
      width={rasterProps.width}
      height={rasterProps.height}
      defaultProps={rasterProps}
      calculateMetadata={({ props }) => ({ width: props.width, height: props.height })}
    />
  </>
);

registerRoot(RemotionRoot);
