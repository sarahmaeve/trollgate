---
version: "alpha"
name: "Maximalist Pop"
description: "Agent-curated design language exported from Katagami as DESIGN.md."
colors:
  primary: "#FF2D7A"
  secondary: "#00C7F2"
  accent: "#FFD84D"
  background: "#FFF4F8"
  surface: "#FFFFFF"
  text: "#141414"
  muted: "#6A5A66"
  border: "#141414"
  error: "#FF5A54"
  success: "#28D17C"
  warning: "#FF9F1C"
  info: "#00C7F2"
typography:
  headline-lg:
    fontFamily: "Bungee, sans-serif"
    fontSize: "2.075rem"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "0.01em"
  headline-md:
    fontFamily: "Bungee, sans-serif"
    fontSize: "1.66rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "0.01em"
  body-md:
    fontFamily: "Space Grotesk, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.01em"
  label-md:
    fontFamily: "IBM Plex Mono, monospace"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.08em"
rounded:
  none: "0px"
  sm: "12px"
  md: "20px"
  lg: "30px"
  full: "999px"
spacing:
  base: "8px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  3xl: "48px"
  4xl: "64px"
components:
  color-reference-primary:
    backgroundColor: "{colors.primary}"
  color-reference-secondary:
    backgroundColor: "{colors.secondary}"
  color-reference-accent:
    backgroundColor: "{colors.accent}"
  color-reference-background:
    backgroundColor: "{colors.background}"
  color-reference-surface:
    backgroundColor: "{colors.surface}"
  color-reference-text:
    backgroundColor: "{colors.text}"
  color-reference-muted:
    backgroundColor: "{colors.muted}"
  color-reference-border:
    backgroundColor: "{colors.border}"
  color-reference-error:
    backgroundColor: "{colors.error}"
  color-reference-success:
    backgroundColor: "{colors.success}"
  color-reference-warning:
    backgroundColor: "{colors.warning}"
  color-reference-info:
    backgroundColor: "{colors.info}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#000000"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  card-surface:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  input-default:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "44px"
---

# Maximalist Pop

## Overview

Maximalist Pop translates pop art, editorial collage, and Memphis-era postmodern exuberance into interface design. It uses consumer-culture brightness, comic-style outlines, sticker layering, and deliberately theatrical hierarchy so the product feels collectible, loud, and joyfully commercial rather than neutral.

### Values

- graphic excess with legible structure
- consumer-culture brightness and immediacy
- playful irreverence
- editorial collage layering
- high-contrast hierarchy that reads instantly

### Anti-Values

- timid neutrality
- austere restraint
- quiet monochrome polish
- invisible hierarchy
- frictionless corporate sameness

### Visual Character

- Every major surface uses thick ink-like outlines with hard-edged offset shadows so cards read like cutout posters pasted on a wall rather than soft digital glass.
- Hero zones combine halftone dots, burst shapes, sticker badges, and rotated labels, creating a layered collage field with visible overlap and deliberate z-axis stacking.
- Display typography is oversized, compressed, and uppercase, while supporting labels use punchy monospace or compact grotesk text to mimic packaging callouts and magazine captions.
- Color blocking relies on hot pink, electric cyan, saturated yellow, acid lime, and black-on-white contrast arranged in adjacent slabs instead of subtle tonal gradients.
- Cards and callouts use asymmetric geometry such as clipped corners, circular badges, and skewed ribbons so the interface keeps a toy-shelf, collectible-object energy.

## Colors

Use the YAML color tokens as the normative palette. The prose below names the roles agents should preserve when generating UI.

| Token | Value |
|-------|-------|
| primary | `#FF2D7A` |
| secondary | `#00C7F2` |
| accent | `#FFD84D` |
| background | `#FFF4F8` |
| surface | `#FFFFFF` |
| text | `#141414` |
| muted | `#6A5A66` |
| border | `#141414` |
| error | `#FF5A54` |
| success | `#28D17C` |
| warning | `#FF9F1C` |
| info | `#00C7F2` |

## Typography

- **Headline-Lg**: Bungee, sans-serif, 2.075rem, weight 700, line-height 1.1.
- **Headline-Md**: Bungee, sans-serif, 1.66rem, weight 600, line-height 1.15.
- **Body-Md**: Space Grotesk, sans-serif, 17px, weight 400, line-height 1.5.
- **Label-Md**: IBM Plex Mono, monospace, 0.75rem, weight 600, line-height 1.

## Layout

### Spacing Tokens

- **Base**: `8px`
- **Xs**: `4px`
- **Sm**: `8px`
- **Md**: `12px`
- **Lg**: `16px`
- **Xl**: `24px`
- **2xl**: `32px`
- **3xl**: `48px`
- **4xl**: `64px`

### Grid

Use a 12-column desktop collage grid with one oversized primary column and one narrower utility column; allow intentional overlap, but anchor each cluster to shared baseline gutters so the chaos still scans cleanly.

### Breakpoints

Desktop keeps overlapping cards and floating stickers; tablet reduces overlap depth and moves to a 2-column stack; mobile becomes a single column with badges tucked inside cards and ribbons flattened to avoid overflow.

### Whitespace

Whitespace acts as a reset between bursts of color and type. Preserve breathing strips around major clusters so the composition feels curated rather than cluttered.

## Elevation & Depth

### Shadows

- **Sm**: 4px 4px 0 0 rgba(20,20,20,0.18)
- **Md**: 8px 8px 0 0 rgba(20,20,20,0.22)
- **Lg**: 14px 14px 0 0 rgba(20,20,20,0.26)

## Shapes

### Rounded

- **None**: `0px`
- **Sm**: `12px`
- **Md**: `20px`
- **Lg**: `30px`
- **Full**: `999px`

### Surfaces

- **Treatment**: paper
- **Card Style**: Bright white cards over candy-color blocks with halftone dot textures, burst decals, and occasional clipped-corner stickers.
- **Bg Pattern**: dots

### Borders

- **Default Width**: 3px
- **Accent Width**: 5px
- **Style**: solid
- **Character**: Borders should feel like comic-book ink contours: dark, assertive, and always visible enough to separate overlapping layers.

## Components

### Composition

Build screens as editorial collages: one dominant hero slab, several overlapping support cards, and a rhythm of badges, ribbons, and mini-panels that feel intentionally collected rather than uniformly tiled.

### Hierarchy

Use oversized display headlines, saturated section bands, circular KPI stickers, and black keylines to make primary actions and numbers readable from a distance before body copy resolves.

### Density

Keep density lively and high, but organize information into bold chunks with visible gutters so the eye gets punctuation between intense color and graphic moments.

### Signature Patterns

- Primary panels use clipped corners or skewed pseudo-elements with thick black outlines, so containers feel like die-cut packaging rather than standard rounded rectangles.
- Section headers sit on rotated ribbons or sticker strips with uppercase mono labels and offset shadows, making hierarchy read like pasted editorial annotations.
- Statistic callouts appear inside circular or pill-shaped badges that overlap adjacent cards and break the grid, preserving a collectible toy-package rhythm.
- Backgrounds and empty areas include halftone dot fields, burst rays, or checker accents applied with CSS gradients, ensuring the language is visibly pop-graphic even before content loads.
- Interactive controls translate by a few pixels on hover while their hard offset shadows collapse, creating a tactile pressed-print effect instead of soft elevation.

## Do's and Don'ts

- Do Use black keylines and offset shadows on every important surface.
- Do Pair oversized display type with compact supporting labels and badges.
- Do Layer stickers, ribbons, and circular metrics so some elements intentionally break the grid.
- Do Use saturated adjacent color blocks instead of quiet tonal palettes.
- Do Keep forms fully styled so even utility controls participate in the graphic language.
- Don't Rely on subtle gray borders or invisible card edges.
- Don't Center everything into a polite symmetrical dashboard.
- Don't Mute the palette into corporate pastels or monochrome restraint.
- Don't Use generic default form controls or browser-native selects.
- Don't Fill every area with noise so thoroughly that hierarchy disappears.
