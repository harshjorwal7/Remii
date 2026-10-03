import { PROFILE_SAMPLES } from './profiles'
import {
  hullOfCircles,
  profileFromPolygon,
  regularPolygonProfile,
  superellipseProfile,
  unionOfCirclesProfile
} from './shape'

/**
 * Formes et couleurs proposees par le personnalisateur du bot.
 *
 * A la difference des silhouettes d'animation (`profiles.ts`), celles-ci ne sont
 * PAS relevees sur la video : elles sont construites analytiquement d'apres la
 * grille du personnalisateur d'origine. Deux sources distinctes, donc, et c'est
 * volontaire — les etats animes doivent rester fideles a la video, les formes de
 * base sont un choix d'utilisateur.
 */

/**
 * Les identifiants sont enumeres plutot que deduits du tableau : c'est ce qui
 * permet a la couche i18n de verifier A LA COMPILATION que chaque forme a bien
 * sa traduction dans les trois langues (`t(\`shapes.${id}\`)` ne compile que si
 * la cle existe). Un `as const` sur le tableau aurait le meme effet mais
 * rendrait `radii` en lecture seule, alors que le moteur le passe tel quel.
 */
export type ShapeId =
  | 'cercle'
  | 'galet'
  | 'squircle'
  | 'capsule'
  | 'triangle'
  | 'hexagone'
  | 'nuage'

export interface BotShape {
  id: ShapeId
  radii: number[]
}

/** Ramene le rayon maximal a `max` pour que toutes les formes pesent pareil a l'oeil. */
function normalize(radii: number[], max = 1): number[] {
  const peak = Math.max(...radii)
  if (peak <= 0) return radii
  const k = max / peak
  return radii.map((r) => r * k)
}

const ANGLES = Array.from({ length: PROFILE_SAMPLES }, (_, i) => (i / PROFILE_SAMPLES) * Math.PI * 2)

/** Galet : cercle deforme par deux harmoniques basses, donc irregulier mais lisse. */
const pebble = normalize(
  ANGLES.map((a) => 1 + 0.075 * Math.cos(2 * a + 0.5) + 0.035 * Math.cos(3 * a + 2.1)),
  1.02
)

/** Nuage : union de bosses, large en bas, deux lobes en haut. */
const cloud = normalize(
  unionOfCirclesProfile([
    { x: -0.44, y: 0.2, r: 0.54 },
    { x: 0.46, y: 0.2, r: 0.5 },
    { x: 0.02, y: 0.3, r: 0.6 },
    { x: -0.24, y: -0.3, r: 0.48 },
    { x: 0.3, y: -0.24, r: 0.44 }
  ]),
  1.02
)

/** Capsule couchee : enveloppe de deux disques cote a cote. */
const capsule = profileFromPolygon(hullOfCircles(-0.42, 0, 0.62, 0.42, 0, 0.62), 0, 0)

export const SHAPES: BotShape[] = [
  { id: 'cercle', radii: new Array(PROFILE_SAMPLES).fill(1) },
  { id: 'galet', radii: pebble },
  // 1.15 et pas 1.02 : sur une superellipse le rayon maximal est la diagonale,
  // donc normaliser dessus donne une forme qui parait plus petite que le cercle.
  { id: 'squircle', radii: normalize(superellipseProfile(4.2), 1.15) },
  { id: 'capsule', radii: capsule },
  // -90deg : un sommet vers le haut de l'ecran (y est oriente vers le bas)
  { id: 'triangle', radii: regularPolygonProfile(3, 1.12, 0.34, -90) },
  // 0deg : sommets a gauche et a droite, donc aretes du haut et du bas plates
  { id: 'hexagone', radii: regularPolygonProfile(6, 1.04, 0.26, 0) },
  { id: 'nuage', radii: cloud }
]

// Map indexee par `string` et non par `ShapeId` : les appelants interrogent avec
// une valeur relue du localStorage ou d'une prop, donc non validee.
export const SHAPE_BY_ID = new Map<string, BotShape>(SHAPES.map((s) => [s.id, s]))
export const DEFAULT_SHAPE = 'cercle'

export type ColorId =
  | 'encre'
  | 'creme'
  | 'brun'
  | 'rouge'
  | 'orange'
  | 'ambre'
  | 'vert'
  | 'turquoise'
  | 'bleu'
  | 'violet'
  | 'rose'

export interface BotColor {
  id: ColorId
  hex: string
}

/**
 * Palette du personnalisateur, relevee en clarte mediane.
 *
 * L'ecran amont montrait ces pastilles seules sur fond clair, ou une teinte
 * tres claire suffit : elle ressort sur du blanc. Dans le produit une pastille
 * est posee dans un rang, a 32 px, cote d'un texte — et le meme produit a un
 * theme noir, ou cette teinte-la disparait dans le fond.
 *
 * Il n'y a pas de couleur qui « saute » sur les deux fonds a la fois si on
 * s'accroche a une extremite : une couleur tres claire se lit mal sur blanc, une
 * couleur tres foncee se lit mal sur noir. La seule famille qui tient sur les
 * deux est celle du milieu : assez claire pour exister sur un fond sombre,
 * assez foncee pour tenir sur un fond clair.
 *
 * Ce qui se joue ensuite, c'est le chroma, et c'est la que ces valeurs ont ete
 * reprises. La palette amont etait mesuree sur des pastilles seules, ou une
 * teinte un peu rabattue se lit encore comme sa teinte ; posee sur le corps d'un
 * bot — une grande surface, entouree de la couleur du fond — elle se ternissait,
 * parce que ses fills avaient le fond pour voisin.
 *
 * Les valeurs ci-dessous disent le reste : chroma a fond, c'est-a-dire aucune
 * melange de blanc ni de noir dans la teinte, et clarte au-dessus de la moitie
 * pour tout ce qui est chromatique. C'est une palette de couleur vive, pas une
 * palette pastel et pas une palette de tons sourds — un rouge rabattu se lit
 * comme du brun, un jaune rabattu comme de la mustard, et c'est cela, et non la
 * clarte, qui faisait « terne » la palette d'origine.
 *
 * Le bandeau de clarte qu'on s'etait fixe ici tient mal des qu'on vise le
 * chroma : il est fait pour un produit a theme sombre ou clair, et ces deux
 * themes sont absents de ce mandat — ce qui a ete demande, c'est de la couleur
 * franche. Une couleur franche est aussi plus facile a lire sur un fond sombre
 * qu'une teinte moyenne, parce que sa clarte reelle depasse la moitie ; sur fond
 * clair elle reste le probleme d'avant, et c'est un arbitrage a trancher cote
 * produit, pas dans cette palette.
 *
 * Les valeurs restent mesurees a l'oeil, pas calculees : c'est une palette, elle
 * se juge sur une image.
 */
export const COLORS: BotColor[] = [
  { id: 'rouge', hex: '#ff2b2b' },
  { id: 'orange', hex: '#ff7a1a' },
  { id: 'ambre', hex: '#ffdd00' },
  { id: 'vert', hex: '#00e04a' },
  { id: 'turquoise', hex: '#00e5c8' },
  { id: 'bleu', hex: '#1f7dff' },
  { id: 'violet', hex: '#9333ff' },
  { id: 'rose', hex: '#ff2ba0' },
  { id: 'creme', hex: '#f5efdd' }
]

export const COLOR_BY_ID = new Map<string, BotColor>(COLORS.map((c) => [c.id, c]))
export const DEFAULT_COLOR = 'bleu'

/** Melange deux couleurs hex. Sert a la brume de profondeur des particules. */
export function mixHex(from: string, to: string, t: number): string {
  const parse = (h: string) => {
    const v = parseInt(h.slice(1), 16)
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
  }
  const a = parse(from)
  const b = parse(to)
  const c = a.map((x, i) => Math.round(x + (b[i]! - x) * t))
  return `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`
}
