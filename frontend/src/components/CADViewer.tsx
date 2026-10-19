'use client';

import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Canvas,
  useThree,
  useFrame,
  type ThreeEvent,
} from '@react-three/fiber';
import {
  OrbitControls,
  useGLTF,
  Grid,
  Html,
  GizmoHelper,
  GizmoViewport,
} from '@react-three/drei';
import * as THREE from 'three';
import {
  AlertTriangle,
  Box,
  Hand,
  Maximize,
  MessageSquare,
  PanelTop,
  Send,
  RotateCcw,
  Square,
  X,
} from 'lucide-react';
import {
  partLabel,
  type CadComponent,
  type CheckItem,
  type ClashResult,
  type DisciplineKey,
  type FindingSeverity,
  type ViewerAnnotation,
} from '@/types/audit';
import { decisionKey } from '@/lib/decisions';
import { anchorKey, type AnnotationStack } from '@/lib/annotations';
import {
  clockTime,
  findingProblem,
  severityOf,
} from '@/lib/review';
import { roleShortLabel } from '@/types/audit';

// --- THEME COLORS ---
export const VIOLATION_COLOR = '#E11D48'; // Strict Red for all errors
export const COMPLIANT_COLOR = '#0284C7'; 
export const STAGE_BACKDROP = '#F8FAFC'; // Light Studio Slate
export const STAGE_BACKDROP_NEAR = '#FFFFFF'; // Pure White
export const STAGE_BACKDROP_FAR = '#E2E8F0'; 
export const GHOST_OPACITY = 0.35;
export const DISCIPLINE_FALLBACK_COLORS = {
  disciplineA: '#8C99A8',
  disciplineB: '#C9A227',
} as const;
export const NEUTRAL_MATERIAL_COLOR = '#B4BECC';

interface MaterialPair {
  compliant: THREE.MeshStandardMaterial;
  ghost: THREE.MeshStandardMaterial;
}

function applyOpacity(material: THREE.Material | THREE.Material[], dim: boolean) {
  const list = Array.isArray(material) ? material : [material];
  list.forEach((entry) => {
    if (dim) {
      entry.transparent = true;
      entry.opacity = GHOST_OPACITY;
      entry.depthWrite = false;
    } else {
      entry.transparent = false;
      entry.opacity = 1;
      entry.depthWrite = true;
    }
    entry.needsUpdate = true;
  });
}

function makeMaterials(): MaterialPair {
  const studio = (color: string, opacity: number) =>
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: 0.4,
      metalness: 0.1,
      side: THREE.DoubleSide,
      transparent: opacity < 1,
      opacity,
      depthWrite: opacity >= 1,
    });

  return {
    compliant: studio('#94A3B8', 1),
    ghost: studio('#CBD5E1', GHOST_OPACITY),
  };
}

function makeBeaconMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: new THREE.Color(VIOLATION_COLOR),
    depthTest: false,
    toneMapped: false,
  });
}

function makeTintMaterial(tint: string | null): THREE.MeshStandardMaterial {
  const color = new THREE.Color(tint ?? NEUTRAL_MATERIAL_COLOR);
  return new THREE.MeshStandardMaterial({
    color,
    metalness: 0.1,
    roughness: 0.55,
    side: THREE.DoubleSide,
  });
}

const COLOR_SAMPLE_LIMIT = 64;

function isVariedColor(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): boolean {
  const count = attribute.count;
  if (count < 2) return false;

  const step = Math.max(1, Math.floor(count / COLOR_SAMPLE_LIMIT));
  const x0 = attribute.getX(0);
  const y0 = attribute.getY(0);
  const z0 = attribute.getZ(0);

  for (let i = step; i < count; i += step) {
    if (attribute.getX(i) !== x0) return true;
    if (attribute.getY(i) !== y0) return true;
    if (attribute.getZ(i) !== z0) return true;
  }
  return false;
}

function hasExplicitColor(mesh: THREE.Mesh): boolean {
  const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
  if (!material) return false;

  const list = Array.isArray(material) ? material : [material];
  return list.some((entry) => {
    const standard = entry as THREE.MeshStandardMaterial;
    if (standard.color && !standard.color.equals(new THREE.Color(0xffffff))) return true;

    const attribute = (mesh.geometry as THREE.BufferGeometry | undefined)?.attributes?.color as
      | THREE.BufferAttribute
      | THREE.InterleavedBufferAttribute
      | undefined;
    return attribute ? isVariedColor(attribute) : false;
  });
}

type CandidateScope = string[] | { discipline: DisciplineKey; candidates: string[] };
const MIN_PREFIX_LEN = 3;
const UNIQUE_SUFFIX = /_\d+$/;
const DISCIPLINE_ID_PREFIX: Record<DisciplineKey, string> = {
  disciplineA: 'a_',
  disciplineB: 'b_',
};

function disciplineOfPartId(partId: string | null | undefined): DisciplineKey | null {
  const lowered = (partId ?? '').toLowerCase();
  if (lowered.startsWith(DISCIPLINE_ID_PREFIX.disciplineA)) return 'disciplineA';
  if (lowered.startsWith(DISCIPLINE_ID_PREFIX.disciplineB)) return 'disciplineB';
  return null;
}

function resolvePartId(meshName: string, candidates: CandidateScope): string | null {
  const name = (meshName || '').toLowerCase().trim();
  if (!name) return null;

  const ids = Array.isArray(candidates) ? candidates : candidates.candidates;
  const discipline = Array.isArray(candidates) ? null : candidates.discipline;

  const exact = ids.find((id) => id.toLowerCase() === name);
  if (exact) return exact;

  const ordered = [...ids].sort((a, b) => b.length - a.length);
  const bounded = (needle: string) =>
    new RegExp(`(^|[^a-z0-9_])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_]|$)`, 'i').test(name);

  for (const id of ordered) {
    const needle = id.toLowerCase();
    if (needle && bounded(needle)) return id;
  }

  if (discipline === null) return null;

  const marker = DISCIPLINE_ID_PREFIX[discipline];
  const stripped = name.startsWith(marker) ? name.slice(marker.length) : name;

  const scoped = ordered.filter((id) => {
    const lowered = id.toLowerCase();
    return lowered.startsWith(marker) && lowered.slice(marker.length).length >= MIN_PREFIX_LEN;
  });

  for (const id of scoped) {
    const suffix = id.toLowerCase().slice(marker.length);
    if (bounded(suffix)) return id;

    const base = suffix.replace(UNIQUE_SUFFIX, '');
    if (base !== suffix && base.length >= MIN_PREFIX_LEN && bounded(base)) return id;
  }

  if (stripped !== name) {
    for (const id of scoped) {
      const suffix = id.toLowerCase().slice(marker.length);
      if (suffix === stripped) return id;
    }
  }

  return null;
}

function placeOnFederatedOrigin(scene: THREE.Object3D, combinedShift?: THREE.Vector3, combinedScale?: number) {
  scene.position.set(0, 0, 0);
  scene.scale.set(1, 1, 1);

  if (combinedShift && combinedScale !== undefined) {
    scene.scale.setScalar(combinedScale);
    scene.position.copy(combinedShift).multiplyScalar(-combinedScale);
    return;
  }

  const box = new THREE.Box3().setFromObject(scene);
  if (box.isEmpty()) return;

  const size = box.getSize(new THREE.Vector3());
  const shift = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const scale = maxDim > 0 ? 50 / maxDim : 1;

  scene.scale.setScalar(scale);
  scene.position.copy(shift).multiplyScalar(-scale);
}

function LoadedModel({
  url,
  failedParts,
  components,
  selectedPartId,
  activePartId,
  selectPartId,
  hiddenParts,
  isolatedPartId,
  placement,
  discipline,
  tint,
  visible,
  onSelectPart,
  onLoaded,
}: {
  url: string;
  failedParts: string[];
  components: CadComponent[];
  selectedPartId: string | null;
  selectPartId: string | null;
  activePartId: string | null;
  hiddenParts: string[];
  isolatedPartId: string | null;
  placement: FederatedPlacement | null;
  discipline: DisciplineKey | null;
  tint: string | null;
  visible: boolean;
  onSelectPart: (partId: string | null) => void;
  onLoaded: (group: THREE.Group) => void;
}) {
  const { scene: loaded } = useGLTF(url);
  const scene = useMemo(() => loaded.clone(true), [loaded]);
  const materials = useMemo(makeMaterials, []);
  const groupRef = useRef<THREE.Group>(null);
  const tintMaterial = useMemo(() => makeTintMaterial(tint), [tint]);
  const prepared = useRef(new WeakSet<THREE.Mesh>());
  const partForMesh = useRef(new WeakMap<THREE.Mesh, string>());

  useEffect(() => {
    prepared.current = new WeakSet<THREE.Mesh>();
    partForMesh.current = new WeakMap<THREE.Mesh, string>();
  }, [scene]);

  useEffect(
    () => () => {
      materials.compliant.dispose();
      materials.ghost.dispose();
      tintMaterial.dispose();
    },
    [materials, tintMaterial]
  );

  useEffect(() => {
    if (!scene) return;

    placeOnFederatedOrigin(scene, placement?.shift, placement?.scale);

    const needles = failedParts.filter((id) => id && id !== 'assembly');
    const hidden = new Set(hiddenParts);
    const painted: THREE.Mesh[] = [];

    scene.traverse((child: THREE.Object3D) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;

      if (mesh.geometry) {
        mesh.geometry.computeVertexNormals();
      }

      const candidateNames = [mesh.name, mesh.parent?.name || '', mesh.geometry.name || ''].filter(Boolean);
      const scope: CandidateScope = {
        discipline: discipline ?? 'disciplineA',
        candidates: [...needles, ...components.map((c) => c.part_id)],
      };

      const matchedId: string | null =
        candidateNames
          .map((name) => resolvePartId(name, discipline ? scope : scope.candidates))
          .find((id): id is string => typeof id === 'string') ?? null;

      if (matchedId !== null) partForMesh.current.set(mesh, matchedId);

      if (!prepared.current.has(mesh)) {
        const keepExportedColor = hasExplicitColor(mesh);

        if (!keepExportedColor) {
          mesh.geometry?.deleteAttribute('color');
          const current = mesh.material as THREE.Material | THREE.Material[] | undefined;
          (Array.isArray(current) ? current : current ? [current] : []).forEach((entry) => {
            if ('vertexColors' in entry) {
              (entry as THREE.MeshStandardMaterial).vertexColors = false;
            }
          });
        }

        const source = keepExportedColor ? null : tint !== null ? tintMaterial : materials.compliant;
        if (source) mesh.material = source.clone();
        prepared.current.add(mesh);
      }

      if (matchedId !== null) {
        const hiddenByUser = hidden.has(matchedId);
        const hiddenByIsolation = isolatedPartId !== null && isolatedPartId !== matchedId;
        mesh.visible = visible && !hiddenByUser && !hiddenByIsolation;
      } else {
        mesh.visible = visible;
      }

      if (mesh.visible) painted.push(mesh);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });

    const onFinding = selectPartId !== null || activePartId !== null;
    const keepOpaque = new Set([selectPartId, activePartId].filter((id): id is string => id !== null));
    const ghosts = (id: string | null): boolean =>
      onFinding && !keepOpaque.has(id ?? '') && !needles.includes(id ?? '');

    painted.forEach((mesh) => {
      applyOpacity(mesh.material, ghosts(partForMesh.current.get(mesh) ?? null));
    });

    if (groupRef.current) {
      onLoaded(groupRef.current);
    }
  }, [
    scene,
    failedParts,
    components,
    hiddenParts,
    isolatedPartId,
    selectPartId,
    activePartId,
    placement,
    discipline,
    tint,
    visible,
    materials,
    tintMaterial,
    onLoaded,
  ]);

  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation();
      const mesh = event.object as THREE.Mesh;
      const known = components.map((component) => component.part_id);
      const partId = resolvePartId(mesh.name, discipline ? { discipline, candidates: known } : known);
      if (!partId) return;
      onSelectPart(partId === selectedPartId ? null : partId);
    },
    [components, discipline, onSelectPart, selectedPartId]
  );

  return (
    <group ref={groupRef} visible={visible}>
      <primitive object={scene} onClick={handleClick} />
    </group>
  );
}

function findPartMesh(
  roots: THREE.Object3D | THREE.Object3D[] | null,
  partId: string,
  discipline?: DisciplineKey | null
): THREE.Mesh | null {
  if (!roots) return null;
  const list = Array.isArray(roots) ? roots : [roots];
  if (list.length === 0) return null;

  let found: THREE.Mesh | null = null;
  const scope: CandidateScope = discipline ? { discipline, candidates: [partId] } : [partId];

  for (const root of list) {
    if (found) break;
    root.traverse((child: THREE.Object3D) => {
      if (found) return;
      const candidate = child as THREE.Mesh;
      if (!candidate.isMesh) return;
      if (resolvePartId(candidate.name, scope) !== null) found = candidate;
    });
  }
  return found;
}

const CLASH_PROXIMITY_TOLERANCE = 2;

function resolveFindingAnchor(
  check: CheckItem,
  groups: THREE.Object3D[],
  components: CadComponent[],
  clash: ClashResult | null,
  placement: FederatedPlacement | null
): THREE.Vector3 | null {
  const meshFor = (partId: string | null | undefined): THREE.Mesh | null => {
    if (!partId) return null;
    const discipline = disciplineOfPartId(partId);
    for (const group of groups) {
      const mesh = findPartMesh(group, partId, discipline);
      if (mesh) return mesh;
    }
    return null;
  };

  const meshCenter = (mesh: THREE.Mesh): THREE.Vector3 | null => {
    const box = new THREE.Box3().setFromObject(mesh);
    return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
  };

  const partId = check.part_id;
  if (!partId) return null;

  const text = `${check.check_name} ${check.fix_instruction ?? ''}`;
  const mentions = (id: string) => {
    if (!id) return false;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(text);
  };

  const clashCenter = (id: string): THREE.Vector3 | null => {
    const component = components.find((c) => c.part_id === id);

    if (component?.center_mm && placement) {
      const { x, y, z } = component.center_mm;
      const point = new THREE.Vector3(x, z, -y);
      return point
        .multiplyScalar(placement.scale)
        .add(placement.shift.clone().multiplyScalar(-placement.scale));
    }
    const mesh = meshFor(id);
    return mesh ? meshCenter(mesh) : null;
  };

  const myCenter = clashCenter(partId);
  if (myCenter && clash) {
    const pair = clash.interferences.find((interference) => {
      const other =
        interference.part_a === partId
          ? interference.part_b
          : interference.part_b === partId
          ? interference.part_a
          : null;
      if (!other || !mentions(partId) || !mentions(other)) return false;

      const otherCenter = clashCenter(other);
      return otherCenter !== null && otherCenter.distanceTo(myCenter) <= CLASH_PROXIMITY_TOLERANCE;
    });

    if (pair) {
      const other = pair.part_a === partId ? pair.part_b : pair.part_a;
      const otherCenter = clashCenter(other);

      if (otherCenter) {
        const overlap = pair.overlap_mm;
        const axis = (a: number, b: number, o: number) => {
          const half = Math.abs(a - b) / 2;
          const reach = Math.max(half - o, 0);
          return (a + b) / 2 + (a < b ? reach : -reach);
        };

        const scale = placement?.scale ?? 1;
        const point = new THREE.Vector3(
          axis(myCenter.x, otherCenter.x, overlap.x * scale),
          axis(myCenter.y, otherCenter.y, overlap.y * scale),
          axis(myCenter.z, otherCenter.z, overlap.z * scale)
        );

        if (point.distanceTo(myCenter) > (myCenter.distanceTo(otherCenter) / 2) * 1.5) {
          return myCenter.clone().add(otherCenter).multiplyScalar(0.5);
        }
        return point;
      }
    }
  }

  if (myCenter) return myCenter;
  const mesh = meshFor(partId);
  return mesh ? meshCenter(mesh) : null;
}

const BEACON_MATERIAL = makeBeaconMaterial();
const RING_PERIOD_SECONDS = 2.2;
const RING_MIN_SCALE = 0.6;
const RING_MAX_SCALE = 6.0;
const BEACON_RING_ORDER = 998;
const BEACON_CORE_ORDER = 999;
const BEACON_NUMBER_ORDER = 1000;

const RING_TEXTURE = (() => {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const r = size / 2;
    const gradient = ctx.createRadialGradient(r, r, r * 0.62, r, r, r);
    gradient.addColorStop(0, 'rgba(255,255,255,0)');
    gradient.addColorStop(0.55, 'rgba(255,255,255,0.85)');
    gradient.addColorStop(0.8, 'rgba(255,255,255,0.95)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
})();

function useBeaconPulse(lead: boolean): number {
  useFrame(({ clock }) => {
    if (!lead) return;
    const phase = clock.getElapsedTime() * 2.2;
    BEACON_MATERIAL.opacity = 0.45 + Math.sin(phase) * 0.2;
    BEACON_MATERIAL.userData.radius = 0.45 + Math.sin(phase) * 0.055;
  });
  return (BEACON_MATERIAL.userData.radius as number | undefined) ?? 0.45;
}

function AlertRing({ anchor, phase }: { anchor: THREE.Vector3; phase: number }) {
  const ref = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);

  useFrame((state) => {
    const t = (state.clock.elapsedTime * RING_PERIOD_SECONDS + phase) % 1;
    if (ref.current) {
      const scale = RING_MIN_SCALE + t * (RING_MAX_SCALE - RING_MIN_SCALE);
      ref.current.scale.setScalar(scale);
    }
    if (matRef.current) {
      matRef.current.opacity = (1 - t) * 0.9;
    }
  });

  return (
    <sprite ref={ref} position={anchor} renderOrder={BEACON_RING_ORDER}>
      <spriteMaterial
        ref={matRef}
        color={VIOLATION_COLOR}
        transparent
        opacity={0.9}
        depthTest={false}
        depthWrite={false}
        toneMapped={false}
        map={RING_TEXTURE}
      />
    </sprite>
  );
}

const BEACON_LEGIBLE_LIMIT = 12;

interface BeaconFinder {
  id: number;
  partId: string;
  checkIndex: number;
  anchor: THREE.Vector3;
}

function clusterBeacons(
  beacons: {
    id: number;
    partId: string;
    checkIndex: number;
    anchor: THREE.Vector3;
    severity: FindingSeverity;
  }[]
): BeaconFinder[] {
  const byPosition = new Map<string, { finder: BeaconFinder; severity: FindingSeverity }>();

  for (const beacon of beacons) {
    const key = `${beacon.anchor.x.toFixed(2)}|${beacon.anchor.y.toFixed(2)}|${beacon.anchor.z.toFixed(2)}`;
    const existing = byPosition.get(key);

    if (!existing) {
      byPosition.set(key, {
        finder: {
          id: beacon.id,
          partId: beacon.partId,
          checkIndex: beacon.checkIndex,
          anchor: beacon.anchor,
        },
        severity: beacon.severity,
      });
      continue;
    }

    // Keep the lowest ID for the cluster
    if (beacon.id < existing.finder.id) {
      existing.finder = { ...existing.finder, id: beacon.id, checkIndex: beacon.checkIndex };
    }
  }

  return [...byPosition.values()].map((entry) => entry.finder);
}

function markerColor(severity: FindingSeverity): string {
  // Enforce strict Red for ALL failures, no orange/blue
  return VIOLATION_COLOR; 
}

function MarkerNumber({ text, color }: { text: string; color: string }) {
  const texture = useMemo(() => {
    const scale = 8;
    const width = 160;
    const height = 80;
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');

    if (ctx) {
      ctx.scale(scale, scale);
      ctx.fillStyle = 'rgba(4, 8, 14, 0.88)';
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, 32, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, 28, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, 32, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.font = 'bold 36px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, width / 2, height / 2 + 1);
    }

    const created = new THREE.CanvasTexture(canvas);
    created.needsUpdate = true;
    return created;
  }, [text, color]);

  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <sprite position={[0, 1.2, 0]} renderOrder={BEACON_NUMBER_ORDER} scale={[2.2, 1.1, 1]}>
      <spriteMaterial map={texture} transparent depthTest={false} depthWrite={false} toneMapped={false} />
    </sprite>
  );
}

// --- NEW 3D-NATIVE IN-SCENE HTML CARDS ---

function InSceneFindingCard({
  index,
  headline,
  problem,
  color,
  onClose,
}: {
  index: number;
  headline: string;
  problem: string;
  color: string;
  onClose: () => void;
}) {
  return (
    <Html position={[0, 0, 0]} center zIndexRange={[100, 0]} style={{ pointerEvents: 'none' }}>
      <div
        className="flex flex-col items-center pointer-events-auto cursor-auto select-text"
        // Pushes the card perfectly above the 3D pin in screen space
        style={{ transform: 'translate(0, -100%)', marginTop: '-36px' }}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()} 
      >
        <div
          className="w-72 rounded-xl border bg-white/95 p-3 shadow-xl backdrop-blur"
          style={{ borderColor: 'rgba(148, 163, 184, 0.4)', borderTop: `4px solid ${color}` }}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="rounded-md px-1.5 py-0.5 text-[10px] font-bold text-white shrink-0"
                style={{ backgroundColor: color }}
              >
                #{index}
              </span>
              <span className="text-xs font-semibold text-slate-900 leading-snug">
                {headline}
              </span>
            </div>
            <button
              onPointerDown={(e) => {
                e.stopPropagation();
                onClose();
              }}
              className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 shrink-0 transition"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {problem && (
            <p className="mt-2 text-[11px] leading-relaxed text-slate-600 max-h-32 overflow-y-auto pr-1">
              {problem}
            </p>
          )}
        </div>
        {/* Subtle CSS downward tail pointing to the dot */}
        <div className="w-0 h-0 border-l-[6px] border-r-[6px] border-t-[8px] border-transparent relative" style={{ borderTopColor: 'rgba(255,255,255,0.95)' }} />
      </div>
    </Html>
  );
}

function InSceneCommentCloud({
  count,
  annotations,
  open,
  color,
  onOpen,
  onClose,
  onAddComment,
}: {
  count: number;
  annotations: ViewerAnnotation[];
  open: boolean;
  color: string;
  onOpen: () => void;
  onClose: () => void;
  onAddComment?: (body: string) => void;
}) {
  const [draft, setDraft] = useState('');

  return (
    <Html position={[0, 0, 0]} center zIndexRange={[90, 0]} style={{ pointerEvents: 'none' }}>
      <div 
        className="flex flex-col items-center pointer-events-auto cursor-auto select-text"
        // Pushes the cloud perfectly below the 3D pin in screen space
        style={{ marginTop: '24px' }}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        {!open ? (
          <button
            onPointerDown={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            className="flex h-7 min-w-7 items-center justify-center gap-1.5 rounded-full border bg-white/95 px-2.5 text-[11px] font-bold shadow-lg transition hover:scale-105"
            style={{ borderColor: color, color: color }}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            {count > 1 && <span>{count}</span>}
          </button>
        ) : (
          <>
            {/* Subtle CSS upward tail pointing to the dot */}
            <div className="w-0 h-0 border-l-[6px] border-r-[6px] border-b-[8px] border-transparent relative" style={{ borderBottomColor: 'rgba(255,255,255,0.95)' }} />
            <div
              className="w-64 rounded-xl border bg-white/95 p-3 shadow-xl backdrop-blur relative"
              style={{ borderColor: 'rgba(148, 163, 184, 0.4)', borderBottom: `4px solid ${color}` }}
            >
              <ul className="max-h-40 space-y-2 overflow-y-auto mb-2 pr-1">
                {annotations.map((a) => (
                  <li key={a.id}>
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="text-[11px] font-semibold text-slate-900">{a.author}</span>
                      <span className="text-[9px] text-slate-500">{roleShortLabel(a.role)}</span>
                      <span className="ml-auto text-[9px] text-slate-400">{clockTime(a.createdAt)}</span>
                    </div>
                    <p className="text-[10px] text-slate-700 leading-relaxed whitespace-pre-wrap">{a.body}</p>
                  </li>
                ))}
              </ul>

              {onAddComment && (
                <form
                  className="flex items-center gap-1 border-t border-slate-100 pt-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (draft.trim()) {
                      onAddComment(draft.trim());
                      setDraft('');
                    }
                  }}
                >
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Add a comment..."
                    className="flex-1 rounded border border-slate-200 px-2 py-1 text-[10px] outline-none focus:border-blue-400 bg-slate-50"
                  />
                  <button
                    type="submit"
                    disabled={!draft.trim()}
                    onPointerDown={(e) => e.stopPropagation()} 
                    className="text-blue-600 disabled:opacity-40 p-1 hover:bg-blue-50 rounded transition"
                  >
                    <Send className="h-3 w-3" />
                  </button>
                </form>
              )}

              <button
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onClose();
                }}
                className="absolute -right-2 -top-2 rounded-full border border-slate-200 bg-white p-1 text-slate-400 shadow-sm hover:text-slate-700 transition"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </>
        )}
      </div>
    </Html>
  );
}

function AnchorBeacon({
  anchor,
  index,
  active,
  pulse,
  severity,
  partId,
  checkIndex,
  headline,
  problem,
  onOpen,
  onClose,
  annotationStack,
  openAnnotationId,
  onOpenAnnotation,
  onCloseAnnotation,
  onAddAnnotation,
}: {
  anchor: THREE.Vector3;
  index: number;
  active: boolean;
  pulse: boolean;
  severity: FindingSeverity;
  partId: string;
  checkIndex: number;
  headline: string;
  problem: string;
  onOpen: (partId: string, checkIndex: number) => void;
  onClose: () => void;
  annotationStack?: AnnotationStack;
  openAnnotationId: string | null;
  onOpenAnnotation: (annotation: ViewerAnnotation) => void;
  onCloseAnnotation: () => void;
  onAddAnnotation?: (body: string, threadKey: string) => void;
}) {
  const radius = useBeaconPulse(pulse);
  const color = markerColor(severity);
  const isCloudOpen = annotationStack && openAnnotationId 
    ? annotationStack.members.some((m) => m.id === openAnnotationId) 
    : false;

  return (
    <group position={anchor}>
      {/* 
        The giant AlertRing is now OUTSIDE the interactive hit group. 
        This prevents it from acting as an invisible shield swallowing nearby clicks. 
      */}
      {active && <AlertRing anchor={new THREE.Vector3(0, 0, 0)} phase={(index * 0.37) % 1} />}

      {/* 3D Geometry and Interaction Core */}
      <group
        onClick={(e) => {
          e.stopPropagation();
          if (active) {
            onClose();
          } else {
            onOpen(partId, checkIndex);
          }
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          document.body.style.cursor = 'auto';
        }}
      >
        <mesh renderOrder={BEACON_CORE_ORDER}>
          <sphereGeometry args={[radius * 1.5, 16, 16]} />
          <meshBasicMaterial color={color} depthTest={false} toneMapped={false} />
        </mesh>

        <MarkerNumber text={String(index)} color={color} />
      </group>

      {active && headline && (
        <InSceneFindingCard
          index={index}
          headline={headline}
          problem={problem}
          color={color}
          onClose={onClose}
        />
      )}

      {annotationStack && (
        <InSceneCommentCloud
          count={annotationStack.members.length}
          annotations={annotationStack.members}
          open={isCloudOpen}
          color={color}
          onOpen={() => onOpenAnnotation(annotationStack.lead)}
          onClose={onCloseAnnotation}
          onAddComment={
            onAddAnnotation
              ? (body) => onAddAnnotation(body, annotationStack.lead.threadKey)
              : undefined
          }
        />
      )}
    </group>
  );
}

// --- RIG AND SCENE SETUP ---

interface CameraPose {
  target: THREE.Vector3;
  position: THREE.Vector3;
}

interface SyncedPose {
  writer: number;
  nonce: number;
  pose: CameraPose;
}

interface CameraSyncChannel {
  writer: number;
  onPose: (writer: number, pose: CameraPose) => void;
}

const SYNC_SETTLE_EPSILON_SQ = 1e-6;

export type ViewPreset = 'reset' | 'iso' | 'top' | 'front';
export type DragMode = 'orbit' | 'pan';

const PRESET_DIRECTIONS: Record<Exclude<ViewPreset, 'reset'>, THREE.Vector3> = {
  iso: new THREE.Vector3(1, 0.75, 1).normalize(),
  top: new THREE.Vector3(0.001, 1, 0.001).normalize(),
  front: new THREE.Vector3(0, 0, 1),
};

export const VIEW_PRESETS: { preset: ViewPreset; label: string }[] = [
  { preset: 'reset', label: 'Reset view' },
  { preset: 'iso', label: 'Isometric' },
  { preset: 'top', label: 'Top' },
  { preset: 'front', label: 'Front' },
];

function CameraRig({
  modelGroups,
  focus,
  focusNonce = 0,
  viewpoint,
  preset,
  onPresetApplied,
  onUserOrbit,
  sync,
  externalPose,
  ownsPublish = false,
}: {
  modelGroups: THREE.Object3D[];
  focus: PartSelection | null;
  focusNonce?: number;
  viewpoint: CameraFocusRequest | null;
  preset: ViewPreset | null;
  onPresetApplied?: () => void;
  onUserOrbit?: () => void;
  sync?: CameraSyncChannel | null;
  externalPose?: SyncedPose | null;
  ownsPublish?: boolean;
}) {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const controls = useThree((state) => state.controls) as {
    target: THREE.Vector3;
    update: () => void;
    enabled: boolean;
  } | null;

  useEffect(() => {
    if (!ownsPublish) return;
    const target = window as unknown as { __cadViewerCamera?: () => unknown };
    target.__cadViewerCamera = () => ({
      position: camera.position.toArray(),
      target: controls?.target ? controls.target.toArray() : null,
    });
    return () => {
      delete target.__cadViewerCamera;
    };
  }, [camera, controls, ownsPublish]);

  useEffect(() => {
    if (!ownsPublish) return;
    const surface = window as unknown as { __cadViewerFindingAnchor?: () => unknown };
    surface.__cadViewerFindingAnchor = () => currentAnchorWorld.current?.toArray() ?? null;
    return () => {
      delete surface.__cadViewerFindingAnchor;
    };
  }, [ownsPublish]);

  const overview = useRef<{ pose: CameraPose; radius: number } | null>(null);
  const goal = useRef<CameraPose | null>(null);
  const currentAnchorWorld = useRef<THREE.Vector3 | null>(null);

  useEffect(() => {
    currentAnchorWorld.current = focus?.anchor ?? null;
  }, [focus]);

  useEffect(() => {
    if (modelGroups.length === 0) return;

    const box = new THREE.Box3();
    modelGroups.forEach((root) => box.expandByObject(root));
    if (box.isEmpty()) return;

    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 1.0);
    const perspective = camera as THREE.PerspectiveCamera;
    const fov = perspective.fov || 45;
    const distance = (radius / Math.sin((fov * Math.PI) / 360)) * 1.5;

    const direction = new THREE.Vector3(1, 0.75, 1).normalize();
    const position = sphere.center.clone().addScaledVector(direction, distance);

    overview.current = {
      pose: { target: sphere.center.clone(), position },
      radius,
    };

    camera.position.copy(position);
    perspective.near = Math.max(distance / 500, 0.1);
    perspective.far = Math.max(distance * 50, 50000);
    perspective.updateProjectionMatrix();

    if (controls && typeof controls.target?.copy === 'function') {
      controls.target.copy(sphere.center);
      controls.update();
    }
  }, [modelGroups, camera, controls]);

  const appliedPreset = useRef<ViewPreset | null>(null);
  const appliedViewpoint = useRef<number | null>(null);
  const appliedPose = useRef<number | null>(null);
  const appliedFocus = useRef<number | null>(null);

  useEffect(() => {
    if (!viewpoint) return;
    if (appliedViewpoint.current === viewpoint.nonce) return;
    appliedViewpoint.current = viewpoint.nonce;

    goal.current = {
      target: new THREE.Vector3().fromArray(viewpoint.target),
      position: new THREE.Vector3().fromArray(viewpoint.position),
    };
  }, [viewpoint]);

  useEffect(() => {
    if (!sync || !externalPose) return;
    if (externalPose.writer === sync.writer) return;
    if (appliedPose.current === externalPose.nonce) return;
    appliedPose.current = externalPose.nonce;

    arrivingPose.current = true;
    goal.current = {
      target: externalPose.pose.target.clone(),
      position: externalPose.pose.position.clone(),
    };
  }, [externalPose, sync]);

  useEffect(() => {
    if (!overview.current) return;
    if (viewpoint) return;

    if (!preset && appliedPreset.current !== null) {
      appliedPreset.current = null;
      return;
    }

    if (preset) {
      appliedPreset.current = preset;
      const perspective = camera as THREE.PerspectiveCamera;
      const fov = perspective.fov || 45;
      const radius = Math.max(overview.current.radius, 1.0);
      const distance = (radius / Math.sin((fov * Math.PI) / 360)) * 1.5;
      const centre = overview.current.pose.target;

      if (preset === 'reset') {
        goal.current = {
          target: centre.clone(),
          position: overview.current.pose.position.clone(),
        };
      } else {
        goal.current = {
          target: centre.clone(),
          position: centre.clone().addScaledVector(PRESET_DIRECTIONS[preset], distance),
        };
      }
      return;
    }

    if (focus) {
      if (appliedFocus.current === focusNonce) return;
      appliedFocus.current = focusNonce;

      const perspective = camera as THREE.PerspectiveCamera;
      const fov = perspective.fov || 45;
      const radius = Math.max(focus.radius, 0.001);
      const distance = (radius / Math.sin((fov * Math.PI) / 360)) * 2.2;

      const direction = camera.position.clone().sub(overview.current.pose.target).normalize();
      if (direction.lengthSq() < 1e-6) direction.set(1, 0.75, 1).normalize();

      goal.current = {
        target: focus.position.clone(),
        position: focus.position.clone().addScaledVector(direction, distance),
      };
    } else {
      appliedFocus.current = null;
      goal.current = {
        target: overview.current.pose.target.clone(),
        position: overview.current.pose.position.clone(),
      };
    }
  }, [focus, focusNonce, camera, preset, viewpoint]);

  const dragging = useRef(false);
  const arrivingPose = useRef(false);
  const pendingSync = useRef(false);
  const lastFramePosition = useRef<THREE.Vector3 | null>(null);

  useEffect(() => {
    const element = gl.domElement;
    const down = () => {
      dragging.current = true;
      goal.current = null;
      arrivingPose.current = false;
      pendingSync.current = false;
      onUserOrbit?.();
    };
    const up = () => {
      dragging.current = false;
      if (!sync || arrivingPose.current) return;
      pendingSync.current = true;
    };
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointerup', up);
    return () => {
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointerup', up);
    };
  }, [gl, onUserOrbit, sync]);

  useFrame((_, delta) => {
    if (pendingSync.current && !dragging.current && !arrivingPose.current && controls) {
      const still = camera.position.clone();
      const previous = lastFramePosition.current;
      const settled = previous !== null && still.distanceToSquared(previous) < SYNC_SETTLE_EPSILON_SQ;

      if (settled) {
        pendingSync.current = false;
        lastFramePosition.current = null;
        sync?.onPose(sync.writer, {
          target: controls.target.clone(),
          position: still,
        });
      } else {
        lastFramePosition.current = still;
      }
    }

    const pose = goal.current;
    if (!pose || dragging.current || !controls) return;
    const smoothing = 1 - Math.pow(0.001, delta);
    const threshold = 0.01;

    controls.target.lerp(pose.target, smoothing);
    camera.position.lerp(pose.position, smoothing);

    if (
      controls.target.distanceTo(pose.target) < threshold &&
      camera.position.distanceTo(pose.position) < threshold
    ) {
      controls.target.copy(pose.target);
      camera.position.copy(pose.position);
      goal.current = null;
      arrivingPose.current = false;
      controls.update();
      onPresetApplied?.();
      return;
    }

    controls.update();
  });

  return null;
}

function LoadingOverlay({ label }: { label: string }) {
  return (
    <Html center>
      <div className="flex flex-col items-center gap-2 text-slate-600">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
        <span className="whitespace-nowrap text-xs font-medium">{label}</span>
      </div>
    </Html>
  );
}

function ViewportControls({
  preset,
  dragMode,
  onSelect,
  onDragMode,
}: {
  preset: ViewPreset | null;
  dragMode: DragMode;
  onSelect: (preset: ViewPreset) => void;
  onDragMode: (mode: DragMode) => void;
}) {
  const icons: Record<ViewPreset, typeof Box> = {
    reset: RotateCcw,
    iso: Box,
    top: Square,
    front: PanelTop,
  };

  const tool = (key: string, label: string, Icon: typeof Box, active: boolean, onClick: () => void) => (
    <button
      key={key}
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      data-preset={key}
      onClick={onClick}
      className={
        'rounded p-1.5 transition ' +
        (active ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900')
      }
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );

  return (
    <div
      data-testid="viewport-controls"
      className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white/95 p-1 shadow-sm backdrop-blur"
    >
      {tool('orbit', 'Orbit', RotateCcw, dragMode === 'orbit', () => onDragMode('orbit'))}
      {tool('pan', 'Pan', Hand, dragMode === 'pan', () => onDragMode('pan'))}

      <span aria-hidden className="mx-0.5 h-4 w-px bg-slate-200" />

      {VIEW_PRESETS.map(({ preset: value, label }) => {
        const Icon = value === 'reset' ? Maximize : icons[value];
        const name = value === 'reset' ? 'Zoom to fit / reset view' : label;
        return tool(value, name, Icon, preset === value, () => onSelect(value));
      })}
    </div>
  );
}

export interface PartSelection {
  position: THREE.Vector3;
  radius: number;
  anchor?: THREE.Vector3;
}

export interface CameraFocusRequest {
  position: [number, number, number];
  target: [number, number, number];
  nonce: number;
}

const ANCHOR_FOCUS_RADIUS = 10;

export interface FederatedPlacement {
  shift: THREE.Vector3;
  scale: number;
}

export interface FederatedModel {
  modelUrl: string;
  tint?: string;
}

function slotPair<T>(slots: (T | undefined)[] | undefined): {
  disciplineA?: T;
  disciplineB?: T;
} {
  if (!slots || slots.length === 0) return {};
  return { disciplineA: slots[0], disciplineB: slots[1] };
}

const DEFAULT_DISCIPLINE_SUBTITLES: Record<DisciplineKey, string> = {
  disciplineA: 'Piping / Mechanical',
  disciplineB: 'Electrical / Structural',
};

type ViewMode = 'disciplineA' | 'disciplineB' | 'federated';

const FEDERATED_MODES: {
  key: ViewMode;
  label: string;
  title: string;
  tone: string;
}[] = [
  {
    key: 'disciplineA',
    label: 'Discipline A',
    title: 'Discipline A (Mechanical) — isolated',
    tone: DISCIPLINE_FALLBACK_COLORS.disciplineA,
  },
  {
    key: 'disciplineB',
    label: 'Discipline B',
    title: 'Discipline B (Electrical) — isolated',
    tone: DISCIPLINE_FALLBACK_COLORS.disciplineB,
  },
  {
    key: 'federated',
    label: 'Federated Overlay',
    title: 'Federated Overlay — both disciplines, with defects',
    tone: NEUTRAL_MATERIAL_COLOR,
  },
];

function isolationForMode(mode: ViewMode): DisciplineKey[] | null {
  if (mode === 'federated') return null;
  return [mode];
}

function FederatedStage({
  models,
  subtitles,
  failedParts,
  components,
  clash,
  selectedPartId,
  hiddenParts,
  isolatedPartId,
  preset,
  checks,
  activeCheckIndex,
  viewpoint,
  onPresetApplied,
  onUserOrbit,
  onSelectPart,
  onOpenFinding,
  onCloseFinding,
  annotationStacks = [],
  openAnnotationId = null,
  onOpenAnnotation,
  onCloseAnnotation,
  onAddAnnotation,
  scope = null,
  showBeacons = true,
  isolation = null,
  sync = null,
  externalPose = null,
  ownsPublish = false,
  inheritedPlacement = null,
  focusNonce = 0,
  onPlacementResolved,
  onMarkersResolved,
  onAnchorsResolved,
}: {
  models: { disciplineA: FederatedModel; disciplineB?: FederatedModel };
  subtitles: Record<DisciplineKey, string>;
  failedParts: string[];
  components: CadComponent[];
  clash: ClashResult | null;
  selectedPartId: string | null;
  hiddenParts: string[];
  isolatedPartId: string | null;
  preset: ViewPreset | null;
  checks: CheckItem[];
  activeCheckIndex: number | null;
  viewpoint: CameraFocusRequest | null;
  onPresetApplied: () => void;
  onUserOrbit: () => void;
  onSelectPart: (partId: string | null) => void;
  onOpenFinding: (partId: string, checkIndex: number) => void;
  onCloseFinding: () => void;
  annotationStacks?: AnnotationStack[];
  openAnnotationId?: string | null;
  onOpenAnnotation: (annotation: ViewerAnnotation) => void;
  onCloseAnnotation: () => void;
  onAddAnnotation?: (body: string, threadKey: string) => void;
  scope?: DisciplineKey[] | null;
  showBeacons?: boolean;
  isolation?: DisciplineKey[] | null;
  sync?: CameraSyncChannel | null;
  externalPose?: SyncedPose | null;
  ownsPublish?: boolean;
  inheritedPlacement?: FederatedPlacement | null;
  focusNonce?: number;
  onPlacementResolved?: (placement: FederatedPlacement | null) => void;
  onMarkersResolved?: (markers: BeaconFinder[]) => void;
  onAnchorsResolved?: (anchors: Map<string, [number, number, number]>) => void;
}) {
  const [groups, setGroups] = useState<Record<DisciplineKey, THREE.Group | null>>({
    disciplineA: null,
    disciplineB: null,
  });
  const [hiddenDisciplines, setHiddenDisciplines] = useState<DisciplineKey[]>([]);

  const disciplineATint = models.disciplineB ? models.disciplineA.tint ?? DISCIPLINE_FALLBACK_COLORS.disciplineA : null;
  const disciplineBTint = models.disciplineB ? models.disciplineB.tint ?? DISCIPLINE_FALLBACK_COLORS.disciplineB : null;

  const registerGroup = useCallback((key: DisciplineKey, group: THREE.Group | null) => {
    setGroups((current) => (current[key] === group ? current : { ...current, [key]: group }));
  }, []);

  const onLoadedA = useCallback((group: THREE.Group) => registerGroup('disciplineA', group), [registerGroup]);
  const onLoadedB = useCallback((group: THREE.Group) => registerGroup('disciplineB', group), [registerGroup]);

  const placement = useMemo<FederatedPlacement | null>(() => {
    if (inheritedPlacement) return inheritedPlacement;

    const present = (['disciplineA', 'disciplineB'] as const)
      .map((key) => groups[key])
      .filter((group): group is THREE.Group => group !== null);
    if (present.length === 0) return null;

    const combined = new THREE.Box3();
    const scratch = new THREE.Box3();
    const inverse = new THREE.Matrix4();

    present.forEach((group) => {
      group.updateMatrixWorld(true);
      inverse.copy(group.matrixWorld).invert();

      group.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;

        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const bb = mesh.geometry.boundingBox;
        if (!bb) return;

        scratch.copy(bb).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
        combined.union(scratch);
      });
    });

    if (combined.isEmpty()) return null;

    const size = combined.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim < 1) return null;

    return {
      shift: combined.getCenter(new THREE.Vector3()),
      scale: 50 / maxDim,
    };
  }, [groups, inheritedPlacement]);

  const metricsPlacement = useMemo<FederatedPlacement | null>(() => {
    if (inheritedPlacement) return inheritedPlacement;

    const boxes = components
      .map((component) => ({ component, center: component.center_mm }))
      .filter((entry) => entry.center);

    if (boxes.length === 0) return null;

    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

    boxes.forEach(({ component, center }) => {
      const dims = component.dimensions_mm;
      if (!center || !dims) return;
      const half = new THREE.Vector3(dims.length_x / 2, dims.width_y / 2, dims.height_z / 2);
      const c = new THREE.Vector3(center.x, center.y, center.z);
      min.min(c.clone().sub(half));
      max.max(c.clone().add(half));
    });

    if (!Number.isFinite(min.x) || !Number.isFinite(max.x)) return null;

    const size = max.clone().sub(min);
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim <= 0) return null;

    return {
      shift: min.clone().add(max.clone()).multiplyScalar(0.5),
      scale: 50 / maxDim,
    };
  }, [components, inheritedPlacement]);

  const effectivePlacement = useMemo<FederatedPlacement | null>(() => {
    if (!metricsPlacement) return placement;
    if (!placement) return metricsPlacement;

    const ratio = placement.scale / metricsPlacement.scale;
    const agrees = ratio > 0.5 && ratio < 2;

    return agrees ? placement : metricsPlacement;
  }, [placement, metricsPlacement]);

  useEffect(() => {
    if (!onPlacementResolved || inheritedPlacement) return;
    onPlacementResolved(effectivePlacement);
  }, [effectivePlacement, inheritedPlacement, onPlacementResolved]);

  const modelGroups = useMemo<THREE.Group[]>(
    () =>
      (['disciplineA', 'disciplineB'] as const)
        .map((key) => groups[key])
        .filter((group): group is THREE.Group => group !== null),
    [groups]
  );

  const selection = useMemo(() => {
    if (!selectedPartId || modelGroups.length === 0) return null;

    const component = components.find((c) => c.part_id === selectedPartId);
    if (!component) return null;

    const mesh = findPartMesh(modelGroups, component.part_id);
    if (!mesh) return null;

    const box = new THREE.Box3().setFromObject(mesh);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) / 2;

    return { position: center, radius };
  }, [modelGroups, components, selectedPartId]);

  const beacons = useMemo(() => {
    if (modelGroups.length === 0) return [];

    return checks
      .map((check, checkIndex) => {
        const anchor = resolveFindingAnchor(check, modelGroups, components, clash, effectivePlacement);
        return anchor ? { partId: check.part_id, checkIndex, anchor } : null;
      })
      .filter((entry): entry is { partId: string; checkIndex: number; anchor: THREE.Vector3 } => entry !== null);
  }, [modelGroups, checks, components, clash, effectivePlacement]);

  const findingAnchors = useMemo(() => {
    const table = new Map<string, [number, number, number]>();
    beacons.forEach((beacon) => {
      const check = checks[beacon.checkIndex];
      if (!check) return;
      table.set(decisionKey(check, beacon.checkIndex), [beacon.anchor.x, beacon.anchor.y, beacon.anchor.z]);
    });
    return table;
  }, [beacons, checks]);

  useEffect(() => {
    onAnchorsResolved?.(findingAnchors);
  }, [findingAnchors, onAnchorsResolved]);

  // CRITICAL FIX: "nothing when everything is good" 
  // We explicitly filter out ANY markers that are compliant (PASS).
  const markers = useMemo(() => {
    const errorBeacons = beacons
      .map((beacon) => ({
        ...beacon,
        id: beacon.checkIndex + 1,
        severity: severityOf(checks[beacon.checkIndex]),
      }))
      .filter(b => b.severity === 'critical' || b.severity === 'warning');

    return clusterBeacons(errorBeacons);
  }, [beacons, checks]);

  const activeCheckAnchor = useMemo(() => {
    if (activeCheckIndex === null) return null;
    return beacons.find((b) => b.checkIndex === activeCheckIndex)?.anchor ?? null;
  }, [activeCheckIndex, beacons]);

  const visibleMarkers = useMemo(() => {
    if (markers.length <= BEACON_LEGIBLE_LIMIT) return markers;
    return markers.filter(
      (marker) => marker.checkIndex === activeCheckIndex || (selectedPartId !== null && marker.partId === selectedPartId)
    );
  }, [markers, activeCheckIndex, selectedPartId]);

  useEffect(() => {
    onMarkersResolved?.(markers);
  }, [markers, onMarkersResolved]);

  const focusTarget = useMemo<PartSelection | null>(() => {
    if (preset) return null;
    if (activeCheckAnchor) {
      return {
        position: activeCheckAnchor,
        radius: ANCHOR_FOCUS_RADIUS,
        anchor: activeCheckAnchor,
      };
    }
    return selection ? { position: selection.position, radius: selection.radius } : null;
  }, [preset, activeCheckAnchor, selection]);

  const draws = (key: DisciplineKey): boolean => scope === null || scope.includes(key);

  const shows = (key: DisciplineKey): boolean =>
    !hiddenDisciplines.includes(key) && (isolation === null || isolation.includes(key));

  const pinAt = useMemo(() => {
    const map = new Map<string, AnnotationStack>();
    annotationStacks.forEach((stack) => {
      map.set(anchorKey(stack.lead.anchor), stack);
    });
    return map;
  }, [annotationStacks]);

  return (
    <>
      {draws('disciplineA') && (
        <group visible={shows('disciplineA')}>
          <LoadedModel
            url={models.disciplineA.modelUrl}
            failedParts={failedParts}
            components={components}
            selectedPartId={selectedPartId}
            selectPartId={selectedPartId}
            activePartId={activeCheckIndex !== null ? checks[activeCheckIndex]?.part_id ?? null : null}
            hiddenParts={hiddenParts}
            isolatedPartId={isolatedPartId}
            placement={effectivePlacement}
            discipline={models.disciplineB ? 'disciplineA' : null}
            tint={disciplineATint}
            visible={shows('disciplineA')}
            onSelectPart={onSelectPart}
            onLoaded={onLoadedA}
          />
        </group>
      )}

      {models.disciplineB && draws('disciplineB') && (
        <group visible={shows('disciplineB')}>
          <LoadedModel
            url={models.disciplineB.modelUrl}
            failedParts={failedParts}
            components={components}
            selectedPartId={selectedPartId}
            selectPartId={selectedPartId}
            activePartId={activeCheckIndex !== null ? checks[activeCheckIndex]?.part_id ?? null : null}
            hiddenParts={hiddenParts}
            isolatedPartId={isolatedPartId}
            placement={effectivePlacement}
            discipline="disciplineB"
            tint={disciplineBTint}
            visible={shows('disciplineB')}
            onSelectPart={onSelectPart}
            onLoaded={onLoadedB}
          />
        </group>
      )}

      {/* Render Native 3D Anchors, Cards, and Cloud buttons */}
      {showBeacons &&
        visibleMarkers.map((marker, markerIndex) => {
          // If the coordinate perfectly matches the active check, we use the active check's ID and text 
          // (fixes the bug where clustered beacons swallow the popup details of overlapping checks).
          const isCoordinateActive = activeCheckAnchor !== null && marker.anchor.distanceToSquared(activeCheckAnchor) < 0.001;
          const isActive = activeCheckIndex === marker.checkIndex || isCoordinateActive;
          
          const displayCheckIndex = isActive && activeCheckIndex !== null ? activeCheckIndex : marker.checkIndex;
          const displayId = isActive && activeCheckIndex !== null ? activeCheckIndex + 1 : marker.id;
          
          const check = checks[displayCheckIndex];
          const stack = pinAt.get(anchorKey([marker.anchor.x, marker.anchor.y, marker.anchor.z]));
          
          return (
            <AnchorBeacon
              key={marker.id}
              anchor={marker.anchor}
              index={displayId}
              active={isActive}
              pulse={markerIndex === 0}
              severity={severityOf(check)}
              partId={check.part_id}
              checkIndex={displayCheckIndex}
              headline={check?.check_name ?? ''}
              problem={check ? findingProblem(check) : ''}
              onOpen={onOpenFinding}
              onClose={onCloseFinding}
              annotationStack={stack}
              openAnnotationId={openAnnotationId}
              onOpenAnnotation={onOpenAnnotation}
              onCloseAnnotation={onCloseAnnotation}
              onAddAnnotation={onAddAnnotation}
            />
          );
        })}

      <CameraRig
        modelGroups={modelGroups}
        focus={focusTarget}
        focusNonce={focusNonce}
        preset={preset}
        viewpoint={viewpoint}
        onPresetApplied={onPresetApplied}
        onUserOrbit={onUserOrbit}
        sync={sync}
        externalPose={externalPose}
        ownsPublish={ownsPublish}
      />
    </>
  );
}

function ViewportScene({
  models,
  subtitles,
  failedParts,
  components,
  clash,
  selectedPartId,
  hiddenParts,
  isolatedPartId,
  preset,
  checks,
  activeCheckIndex,
  viewpoint,
  dragMode,
  onPresetApplied,
  onUserOrbit,
  onSelectPart,
  onOpenFinding,
  onCloseFinding,
  annotationStacks = [],
  openAnnotationId = null,
  onOpenAnnotation,
  onCloseAnnotation,
  onAddAnnotation,
  scope,
  showBeacons = true,
  sync = null,
  externalPose = null,
  ownsPublish = false,
  inheritedPlacement = null,
  isolation = null,
  focusNonce = 0,
  scaleChrome = true,
  shadows = true,
  dpr = [1, 2] as [number, number],
  onPointerMissed,
  onPlacementResolved,
  onMarkersResolved,
  onAnchorsResolved,
}: {
  models: { disciplineA: FederatedModel; disciplineB?: FederatedModel };
  subtitles: Record<DisciplineKey, string>;
  failedParts: string[];
  components: CadComponent[];
  clash: ClashResult | null;
  selectedPartId: string | null;
  hiddenParts: string[];
  isolatedPartId: string | null;
  preset: ViewPreset | null;
  checks: CheckItem[];
  activeCheckIndex: number | null;
  viewpoint: CameraFocusRequest | null;
  dragMode: DragMode;
  onPresetApplied: () => void;
  onUserOrbit: () => void;
  onSelectPart: (partId: string | null) => void;
  onOpenFinding: (partId: string, checkIndex: number) => void;
  onCloseFinding: () => void;
  annotationStacks?: AnnotationStack[];
  openAnnotationId?: string | null;
  onOpenAnnotation: (annotation: ViewerAnnotation) => void;
  onCloseAnnotation: () => void;
  onAddAnnotation?: (body: string, threadKey: string) => void;
  scope?: DisciplineKey[] | null;
  showBeacons?: boolean;
  sync?: CameraSyncChannel | null;
  externalPose?: SyncedPose | null;
  ownsPublish?: boolean;
  inheritedPlacement?: FederatedPlacement | null;
  isolation?: DisciplineKey[] | null;
  scaleChrome?: boolean;
  shadows?: boolean;
  dpr?: [number, number];
  onPointerMissed?: () => void;
  onPlacementResolved?: (placement: FederatedPlacement | null) => void;
  onMarkersResolved?: (markers: BeaconFinder[]) => void;
  onAnchorsResolved?: (anchors: Map<string, [number, number, number]>) => void;
  focusNonce?: number;
}) {
  return (
    <Canvas
      shadows={shadows}
      dpr={dpr}
      camera={{ position: [150, 150, 150], fov: 45, near: 0.1, far: 50000 }}
      gl={{ antialias: true, alpha: true }}
      onPointerMissed={onPointerMissed}
    >
      <ambientLight intensity={1.1} />
      <hemisphereLight args={['#FFFFFF', '#CBD5E1', 0.9]} />
      <directionalLight position={[10, 20, 15]} intensity={1.6} castShadow={shadows} shadow-mapSize={[2048, 2048]} />
      <directionalLight position={[-10, 5, -10]} intensity={0.5} />

      <Suspense fallback={<LoadingOverlay label="Loading geometry" />}>
        <FederatedStage
          models={models}
          subtitles={subtitles}
          failedParts={failedParts}
          components={components}
          clash={clash}
          selectedPartId={selectedPartId}
          hiddenParts={hiddenParts}
          isolatedPartId={isolatedPartId}
          preset={preset}
          checks={checks}
          activeCheckIndex={activeCheckIndex}
          viewpoint={viewpoint}
          onPresetApplied={onPresetApplied}
          onUserOrbit={onUserOrbit}
          onSelectPart={onSelectPart}
          onOpenFinding={onOpenFinding}
          onCloseFinding={onCloseFinding}
          annotationStacks={annotationStacks}
          openAnnotationId={openAnnotationId}
          onOpenAnnotation={onOpenAnnotation}
          onCloseAnnotation={onCloseAnnotation}
          onAddAnnotation={onAddAnnotation}
          scope={scope}
          showBeacons={showBeacons}
          isolation={isolation}
          sync={sync}
          externalPose={externalPose}
          ownsPublish={ownsPublish}
          inheritedPlacement={inheritedPlacement}
          onPlacementResolved={onPlacementResolved}
          onMarkersResolved={onMarkersResolved}
          onAnchorsResolved={onAnchorsResolved}
          focusNonce={focusNonce}
        />
      </Suspense>

      {scaleChrome && (
        <>
          <Grid
            cellSize={2.5}
            cellThickness={0.5}
            cellColor="#CBD5E1"
            sectionSize={12.5}
            sectionThickness={1}
            sectionColor="#94A3B8"
            infiniteGrid
            fadeDistance={800}
            fadeStrength={1}
            followCamera={false}
          />
          <GizmoHelper alignment="bottom-right" margin={[76, 76]}>
            <GizmoViewport axisColors={['#dc2626', '#16a34a', '#2563eb']} labelColor="#0f172a" hideNegativeAxes />
          </GizmoHelper>
        </>
      )}

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        mouseButtons={
          dragMode === 'pan'
            ? { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
            : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
        }
      />
    </Canvas>
  );
}

export interface CADViewerProps {
  modelUrl: string;
  secondaryModelUrl?: string | null;
  disciplineTints?: (string | undefined)[];
  disciplineSubtitles?: (string | undefined)[];
  failedParts: string[];
  components: CadComponent[];
  checks: CheckItem[];
  clash?: ClashResult | null;
  selectedPartId: string | null;
  hiddenParts: string[];
  isolatedPartId: string | null;
  selectedCheckIndex?: number | null;
  focusCamera?: CameraFocusRequest | null;
  onFocusCameraApplied?: () => void;
  onSelectPart: (partId: string | null) => void;
  onOpenFinding?: (partId: string, checkIndex: number) => void;
  onCloseFinding?: () => void;
  onAnchorsResolved?: (anchors: Map<string, [number, number, number]>) => void;
  annotationStacks?: AnnotationStack[];
  openAnnotationId?: string | null;
  onOpenAnnotation?: (annotation: ViewerAnnotation) => void;
  onCloseAnnotation?: () => void;
  onAddAnnotation?: (body: string, threadKey: string) => void;
  className?: string;
  fill?: boolean;
}

export default function CADViewer({
  modelUrl,
  secondaryModelUrl = null,
  disciplineTints,
  disciplineSubtitles,
  failedParts,
  components,
  checks,
  clash = null,
  selectedPartId,
  hiddenParts,
  isolatedPartId,
  selectedCheckIndex = null,
  focusCamera = null,
  onFocusCameraApplied,
  onSelectPart,
  onOpenFinding,
  onCloseFinding,
  onAnchorsResolved,
  annotationStacks = [],
  openAnnotationId = null,
  onOpenAnnotation,
  onCloseAnnotation,
  onAddAnnotation,
  className,
  fill = false,
}: CADViewerProps) {
  const failedPartIds = useMemo(() => failedParts.filter((id) => id && id !== 'assembly'), [failedParts]);
  const hasFailures = failedPartIds.length > 0;
  const [preset, setPreset] = useState<ViewPreset | null>(null);
  const [dragMode, setDragMode] = useState<DragMode>('orbit');

  const handlePresetApplied = useCallback(() => setPreset(null), []);
  const handleOrbitStart = useCallback(() => setPreset(null), []);

  const federated = useMemo(() => {
    const tints = slotPair(disciplineTints);
    const titles = slotPair(disciplineSubtitles);
    const subtitles: Record<DisciplineKey, string> = {
      disciplineA: titles.disciplineA ?? DEFAULT_DISCIPLINE_SUBTITLES.disciplineA,
      disciplineB: titles.disciplineB ?? DEFAULT_DISCIPLINE_SUBTITLES.disciplineB,
    };

    if (!secondaryModelUrl) {
      return { models: { disciplineA: { modelUrl, tint: tints.disciplineA } }, subtitles };
    }

    return {
      models: {
        disciplineA: { modelUrl, tint: tints.disciplineA },
        disciplineB: { modelUrl: secondaryModelUrl, tint: tints.disciplineB },
      },
      subtitles,
    };
  }, [modelUrl, secondaryModelUrl, disciplineTints, disciplineSubtitles]);

  const [viewMode, setViewMode] = useState<ViewMode>('federated');
  const isolation = useMemo(() => isolationForMode(viewMode), [viewMode]);
  const splitView = Boolean(secondaryModelUrl);

  const [sharedPlacement, setSharedPlacement] = useState<FederatedPlacement | null>(null);
  const handlePlacementResolved = useCallback((next: FederatedPlacement | null) => {
    setSharedPlacement((current) => {
      if (!current && !next) return current;
      if (current && next && current.scale === next.scale && current.shift.equals(next.shift)) return current;
      return next;
    });
  }, []);

  useEffect(() => {
    setSharedPlacement(null);
  }, [modelUrl, secondaryModelUrl]);

  const openFinding = onOpenFinding ?? (() => {});
  const clearSelection = useCallback(() => onSelectPart(null), [onSelectPart]);

  const handleMarkerOpen = useCallback(
    (partId: string, checkIndex: number) => {
      setFocusNonce((current) => current + 1);
      openFinding(partId, checkIndex);
    },
    [openFinding]
  );

  const handleAnnotationOpen = useCallback(
    (annotation: ViewerAnnotation) => {
      setFocusNonce((current) => current + 1);
      onOpenAnnotation?.(annotation);
    },
    [onOpenAnnotation]
  );

  const closeFinding = onCloseFinding ?? (() => {});
  const closeAnnotation = onCloseAnnotation ?? (() => {});

  const [focusNonce, setFocusNonce] = useState(0);
  const [markers, setMarkers] = useState<BeaconFinder[]>([]);
  const handleMarkersResolved = useCallback((next: BeaconFinder[]) => {
    setMarkers((current) => {
      if (current.length === next.length) {
        const same = current.every(
          (marker, index) =>
            marker.id === next[index].id &&
            marker.checkIndex === next[index].checkIndex &&
            marker.anchor.equals(next[index].anchor)
        );
        if (same) return current;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    setMarkers([]);
    setFocusNonce(0);
  }, [modelUrl, secondaryModelUrl]);

  if (splitView) {
    return (
      <div className={className}>
        <div
          className={'relative h-full w-full min-h-0 overflow-hidden ring-1 ring-slate-200 ' + (fill ? '' : 'rounded-xl')}
          style={{
            background:
              'radial-gradient(120% 90% at 50% 42%, ' +
              STAGE_BACKDROP_NEAR +
              ' 0%, ' +
              STAGE_BACKDROP +
              ' 62%, ' +
              STAGE_BACKDROP_FAR +
              ' 100%)',
          }}
        >
          <div className="relative flex h-full w-full min-h-0 flex-col">
            <div className="pointer-events-none absolute left-1/2 top-14 z-20 flex -translate-x-1/2 flex-wrap items-center justify-center gap-2">
              <div className="pointer-events-auto flex flex-wrap items-center gap-2">
                <ViewportControls preset={preset} dragMode={dragMode} onSelect={setPreset} onDragMode={setDragMode} />

                <div
                  role="tablist"
                  aria-label="Viewport mode"
                  data-testid="viewport-mode-switcher"
                  className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white/95 p-1 shadow-sm backdrop-blur"
                >
                  {FEDERATED_MODES.map((mode) => {
                    const active = viewMode === mode.key;
                    return (
                      <button
                        key={mode.key}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        data-testid={`viewport-mode-${mode.key}`}
                        onClick={() => setViewMode(mode.key)}
                        title={mode.title}
                        className={
                          'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition ' +
                          (active
                            ? 'bg-blue-600 text-white shadow-sm'
                            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')
                        }
                      >
                        <span
                          aria-hidden
                          className="h-2 w-2 shrink-0 rounded-sm ring-1 ring-black/10"
                          style={{ backgroundColor: mode.tone }}
                        />
                        {mode.label}
                      </button>
                    );
                  })}
                </div>

                <div className="hidden items-center gap-3 rounded-lg border border-slate-200 bg-white/95 px-3 py-1.5 text-[11px] font-medium text-slate-700 shadow-sm backdrop-blur lg:flex">
                  {hasFailures && (
                    <span className="flex items-center gap-1.5 border-l border-slate-200 pl-3">
                      <span className="h-2.5 w-2.5 rounded-full ring-1 ring-white" style={{ backgroundColor: VIOLATION_COLOR }} />
                      Finding
                      {checks.length > BEACON_LEGIBLE_LIMIT && (
                        <span className="font-normal text-slate-500" title={`${checks.length} findings.`}>
                          · {checks.length} total
                        </span>
                      )}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="relative min-h-0 flex-1">
              <ViewportScene
                models={federated.models}
                subtitles={federated.subtitles}
                failedParts={failedParts}
                components={components}
                clash={clash}
                selectedPartId={selectedPartId}
                hiddenParts={hiddenParts}
                isolatedPartId={isolatedPartId}
                preset={preset}
                checks={checks}
                activeCheckIndex={selectedCheckIndex}
                viewpoint={focusCamera}
                dragMode={dragMode}
                onPresetApplied={focusCamera ? () => onFocusCameraApplied?.() : handlePresetApplied}
                onUserOrbit={handleOrbitStart}
                onSelectPart={onSelectPart}
                onOpenFinding={handleMarkerOpen}
                onCloseFinding={closeFinding}
                annotationStacks={annotationStacks}
                openAnnotationId={openAnnotationId}
                onOpenAnnotation={handleAnnotationOpen}
                onCloseAnnotation={closeAnnotation}
                onAddAnnotation={onAddAnnotation}
                scope={null}
                isolation={isolation}
                showBeacons={isolation === null}
                inheritedPlacement={sharedPlacement}
                onPlacementResolved={handlePlacementResolved}
                onMarkersResolved={handleMarkersResolved}
                onAnchorsResolved={onAnchorsResolved}
                ownsPublish
                focusNonce={focusNonce}
                onPointerMissed={clearSelection}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <div
        className={'relative h-full w-full overflow-hidden ring-1 ring-slate-200 ' + (fill ? '' : 'rounded-xl')}
        style={{
          background:
            'radial-gradient(120% 90% at 50% 42%, ' +
            STAGE_BACKDROP_NEAR +
            ' 0%, ' +
            STAGE_BACKDROP +
            ' 62%, ' +
            STAGE_BACKDROP_FAR +
            ' 100%)',
        }}
      >
        <ViewportScene
          models={federated.models}
          subtitles={federated.subtitles}
          failedParts={failedParts}
          components={components}
          clash={clash}
          selectedPartId={selectedPartId}
          hiddenParts={hiddenParts}
          isolatedPartId={isolatedPartId}
          preset={preset}
          checks={checks}
          activeCheckIndex={selectedCheckIndex}
          viewpoint={focusCamera}
          dragMode={dragMode}
          onPresetApplied={focusCamera ? () => onFocusCameraApplied?.() : handlePresetApplied}
          onUserOrbit={handleOrbitStart}
          onSelectPart={onSelectPart}
          onOpenFinding={handleMarkerOpen}
          onCloseFinding={closeFinding}
          annotationStacks={annotationStacks}
          openAnnotationId={openAnnotationId}
          onOpenAnnotation={handleAnnotationOpen}
          onCloseAnnotation={closeAnnotation}
          onAddAnnotation={onAddAnnotation}
          ownsPublish
          focusNonce={focusNonce}
          onMarkersResolved={handleMarkersResolved}
          onAnchorsResolved={onAnchorsResolved}
          onPointerMissed={() => onSelectPart(null)}
        />

        <div className="pointer-events-none absolute left-3 top-14">
          <ViewportControls preset={preset} dragMode={dragMode} onSelect={setPreset} onDragMode={setDragMode} />
        </div>

        <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col items-start gap-2">
          {secondaryModelUrl && (
            <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white/95 px-3 py-2 text-[11px] font-medium text-slate-700 shadow-sm backdrop-blur">
              {(
                [
                  ['disciplineA', 'Discipline 1'],
                  ['disciplineB', 'Discipline 2'],
                ] as const
              ).map(([key, label]) => (
                <span key={key} className="flex items-center gap-1.5">
                  <span
                    className="h-2.5 w-2.5 rounded-sm"
                    style={{ backgroundColor: DISCIPLINE_FALLBACK_COLORS[key] }}
                  />
                  {label}
                </span>
              ))}
            </div>
          )}

          {hasFailures && (
            <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white/95 px-3 py-2 text-[11px] font-medium text-slate-700 shadow-sm backdrop-blur">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full ring-1 ring-white" style={{ backgroundColor: VIOLATION_COLOR }} />
                Finding
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: COMPLIANT_COLOR }} />
                Component
              </span>
            </div>
          )}
        </div>

        {!selectedPartId && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded-lg border border-slate-200 bg-white/90 px-3 py-1.5 text-[11px] text-slate-500 shadow-sm backdrop-blur lg:block">
            Click a part to inspect · Drag to orbit · Scroll to zoom
          </div>
        )}
      </div>

      {hasFailures && (
        <p className="mt-2.5 flex items-center gap-2 text-xs text-rose-700">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>
            {failedPartIds.length} non-compliant component
            {failedPartIds.length === 1 ? '' : 's'} marked in the model:{' '}
            <span className="font-mono text-rose-700">{failedPartIds.map(partLabel).join(', ')}</span>
          </span>
        </p>
      )}
    </div>
  );
}