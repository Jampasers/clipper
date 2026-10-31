/* Renders a sanitized SVG (as a data URI) to a transparent PNG still via
   Remotion's headless Chrome. Used by the watermark manager to rasterize SVG
   uploads safely before FFmpeg ever sees them. */
import React from 'react';
import { AbsoluteFill } from 'remotion';

export interface WatermarkRasterProps {
  dataUri: string;
  width: number;
  height: number;
}

export const WatermarkRaster: React.FC<WatermarkRasterProps> = ({ dataUri }) => (
  <AbsoluteFill style={{ backgroundColor: 'transparent' }}>
    <img src={dataUri} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
  </AbsoluteFill>
);
