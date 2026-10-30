// Stand-ins for the lucide-react icons the Base44 builder used (no icon dependency in @smartmemory/stratum-ui).
import React from 'react';

const glyph = (char, label) => {
  function Icon({ className, strokeWidth: _strokeWidth, ...rest }) {
    return <span aria-hidden="true" className={className} style={{ display: 'inline-grid', placeItems: 'center', lineHeight: 1 }} {...rest}>{char}</span>;
  }
  Icon.displayName = label;
  return Icon;
};

export const Check = glyph('✓', 'Check');
export const X = glyph('×', 'X');
export const AlertTriangle = glyph('!', 'AlertTriangle');
export const Copy = glyph('⧉', 'Copy');
export const Download = glyph('↓', 'Download');
export const Upload = glyph('↑', 'Upload');
export const ShieldCheck = glyph('✓', 'ShieldCheck');
export const Trash2 = glyph('⌫', 'Trash2');
