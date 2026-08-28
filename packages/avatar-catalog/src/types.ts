export interface BodyShapeDefinition {
  id: string;
  viewBox: { width: number; height: number };
  faceCenter: { x: number; y: number };
  svgPath: string;
}

export interface EyePathDefinition {
  svgPath: string;
  color: string; // hex e.g. "#F2F2F2"
}

export interface EyeStyleDefinition {
  id: string;
  sourceViewBox: { width: number; height: number };
  eyeCenter: { x: number; y: number };
  paths: EyePathDefinition[];
}

export interface ColorDefinition {
  id: string;
  hex: string; // e.g. "#4C9B50"
}

export interface FaceCenterOverride {
  bodyShape: string;
  eyeStyle: string;
  faceCenter: { x: number; y: number };
}

export interface CharacterComponents {
  bodyShapes: BodyShapeDefinition[];
  eyeStyles: EyeStyleDefinition[];
  colors: ColorDefinition[];
  faceCenterOverrides: FaceCenterOverride[];
}
