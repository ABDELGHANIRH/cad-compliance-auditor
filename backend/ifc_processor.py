"""
Universal IFC geometry extraction and GLB conversion.

Handles arbitrary uploaded IFC files (IFC2X3, IFC4) with mixed solid types
(CSG, B-Rep, Extruded solids, Swept disks). Extracts metrics, generates smooth
normals, and writes a browser-ready GLB file.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Set

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element
import ifcopenshell.util.unit
import numpy as np
import trimesh

logger = logging.getLogger(__name__)

_PSET_INTERNAL_KEYS = frozenset({"id"})
MAX_PROPERTIES_PER_COMPONENT = 60


class IfcProcessingError(RuntimeError):
    """Raised when an IFC file cannot be read or converted into geometry."""


def _round(value: float, digits: int = 2) -> float:
    try:
        val = float(value)
        if val != val or val in (float("inf"), float("-inf")):
            return 0.0
        return round(val, digits)
    except Exception:
        return 0.0


def _unique_part_id(raw_name: str, used: Set[str]) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "_-" else "_" for ch in (raw_name or "").strip()).strip("_")
    if not cleaned:
        cleaned = "element"
    if cleaned not in used:
        used.add(cleaned)
        return cleaned
    suffix = 2
    while f"{cleaned}_{suffix}" in used:
        suffix += 1
    unique = f"{cleaned}_{suffix}"
    used.add(unique)
    return unique


def _element_properties(element: Any) -> Dict[str, Any]:
    props: Dict[str, Any] = {}
    try:
        props["ifc_class"] = str(element.is_a())
    except Exception:
        pass
    try:
        predefined = ifcopenshell.util.element.get_predefined_type(element)
        if predefined:
            props["predefined_type"] = str(predefined)
    except Exception:
        pass
    try:
        etype = ifcopenshell.util.element.get_type(element)
        if etype and getattr(etype, "Name", None):
            props["type_name"] = str(etype.Name)
    except Exception:
        pass
    try:
        mat = ifcopenshell.util.element.get_material(element)
        if mat:
            props["material"] = str(getattr(mat, "Name", mat.is_a()))
    except Exception:
        pass

    try:
        psets = ifcopenshell.util.element.get_psets(element)
        if psets:
            flat: Dict[str, Any] = {}
            for pset_name, properties in psets.items():
                if not isinstance(properties, dict):
                    continue
                for prop_name, val in properties.items():
                    if prop_name in _PSET_INTERNAL_KEYS:
                        continue
                    if len(flat) >= MAX_PROPERTIES_PER_COMPONENT:
                        break
                    if isinstance(val, (int, float, str, bool)):
                        flat[f"{pset_name}.{prop_name}"] = val
            if flat:
                props["properties"] = flat
    except Exception:
        pass

    return props


def process_ifc(ifc_path: str, output_glb_path: str) -> Dict[str, Any]:
    """
    Process an uploaded IFC file at `ifc_path` and export its 3D geometry to `output_glb_path`.
    """
    if not os.path.exists(ifc_path):
        raise IfcProcessingError(f"Uploaded file path not found: {ifc_path}")

    os.makedirs(os.path.dirname(os.path.abspath(output_glb_path)), exist_ok=True)

    try:
        ifc_file = ifcopenshell.open(ifc_path)
    except Exception as exc:
        raise IfcProcessingError(f"Could not parse uploaded IFC file: {exc}") from exc

    # Configure geometric kernel settings for maximum compatibility
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    settings.set(settings.WELD_VERTICES, False)

    # Length units -> millimetres.
    #
    # `ifcopenshell.geom` returns tessellated vertices in METRES, always: it
    # normalises to the SI metre internally regardless of the file's declared
    # length unit. Verified on the fixture - a model declaring .MILLI. .METRE.
    # with an authored 220x300x200 mm box comes back with extents
    # [0.22, 0.30, 0.20] and volume 0.0132, i.e. strictly SI.
    #
    # So the conversion is a fixed x1000 and `calculate_unit_scale` must NOT be
    # used as the factor here. It reports the file's own unit relative to metres
    # (0.001 for a millimetre-authored file), which is already baked into the
    # numbers coming out of the kernel; applying it again scales every dimension
    # by 1/1000. That was the original defect: an IfcWall authored at
    # 5000 x 200 x 2700 mm was measured as 5.0 x 0.2 x 2.7 and failed every
    # dimensional check it should have passed.
    #
    # The unit scale is still read, but only for diagnostics: it records the
    # file's declared unit so a mismatch against the SI-metre assumption above
    # is visible in the logs rather than silent.
    try:
        declared_scale = float(ifcopenshell.util.unit.calculate_unit_scale(ifc_file, "LENGTHUNIT"))
    except Exception:
        declared_scale = 0.0
    logger.debug(
        "IFC declared length scale to metres: %s (kernel output is SI metres; "
        "converting to mm with a fixed x1000)",
        declared_scale,
    )

    mm_scale = 1000.0  # metres -> millimetres

    products = ifc_file.by_type("IfcProduct")
    if not products:
        raise IfcProcessingError("The uploaded IFC file contains no physical IfcProduct entities.")

    scene = trimesh.Scene()
    z_to_y_up = trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0])

    components: List[Dict[str, Any]] = []
    used_ids: Set[str] = set()
    errors_logged: List[str] = []

    for product in products:
        # Ignore purely spatial groupings or ports
        if product.is_a("IfcSpatialStructureElement") or product.is_a("IfcPort"):
            continue
        if not getattr(product, "Representation", None):
            continue

        raw_name = getattr(product, "Name", None) or f"{product.is_a()}_{product.id()}"
        part_id = _unique_part_id(raw_name, used_ids)

        shape = None
        local_frame = False
        # Attempt 1: Standard shape generation
        try:
            shape = ifcopenshell.geom.create_shape(settings, product)
        except Exception as exc1:
            # Attempt 2: Fallback without world coords transformation if product matrix was invalid
            try:
                fallback_settings = ifcopenshell.geom.settings()
                fallback_settings.set(fallback_settings.USE_WORLD_COORDS, False)
                shape = ifcopenshell.geom.create_shape(fallback_settings, product)
                # This geometry is in the element's LOCAL frame, not the shared
                # world frame every other element uses. Dimensions are still
                # valid (an extent survives the change of frame) but the centre
                # is not, so clash detection must exclude this component.
                local_frame = True
                errors_logged.append(
                    f"{part_id} ({product.is_a()}): world-coords shape failed ({exc1}); "
                    "fell back to local coords - excluded from clash detection"
                )
            except Exception as exc2:
                errors_logged.append(f"{part_id} ({product.is_a()}): {exc1} | {exc2}")
                continue

        if not shape or not hasattr(shape, "geometry"):
            continue

        geom = shape.geometry
        raw_verts = list(geom.verts)
        raw_faces = list(geom.faces)

        if len(raw_verts) < 9 or len(raw_faces) < 3:
            continue

        try:
            verts = np.array(raw_verts, dtype=np.float64).reshape(-1, 3) * mm_scale
            faces = np.array(raw_faces, dtype=np.int32).reshape(-1, 3)

            # Weld coincident vertices before measuring. ifcopenshell emits each
            # triangle face with its own unwelded vertices (24 verts for a box,
            # not 8), so without this the surface is not closed: `is_watertight`
            # is False and `volume` comes back as numerical noise (~1e-12) rather
            # than the real figure. Welding is what makes volume meaningful, and
            # it also gives the GLB a correct bounding box.
            mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
            mesh.merge_vertices()

            bounds = np.asarray(mesh.bounds, dtype=float)
            min_c, max_c = bounds[0], bounds[1]
            dims = max_c - min_c
            center = (min_c + max_c) / 2.0

            # Volume from the welded geometry. The kernel's own `geom.volume`
            # attribute does not exist on the ifcopenshell 0.8.5 wheel, so
            # reading it would silently report 0.0 for every element; derive it
            # instead. A non-watertight solid has no meaningful volume, so fall
            # back to 0.0 rather than trusting a garbage figure.
            if mesh.is_watertight:
                volume_mm3 = float(mesh.volume)
            else:
                volume_mm3 = 0.0
                logger.debug("Solid %s is not watertight; reporting volume 0.0", part_id)

            comp_data: Dict[str, Any] = {
                "part_id": part_id,
                "dimensions_mm": {
                    "length_x": _round(dims[0]),
                    "width_y": _round(dims[1]),
                    "height_z": _round(dims[2]),
                },
                "center_mm": {
                    "x": _round(center[0]),
                    "y": _round(center[1]),
                    "z": _round(center[2]),
                },
                "volume_mm3": _round(volume_mm3),
                "cylindrical_diameters_mm": [],
            }
            if local_frame:
                # Consumed by clash_detector; never part of the LLM prompt.
                comp_data["local_frame"] = True
            comp_data.update(_element_properties(product))
            components.append(comp_data)

            mesh.apply_transform(z_to_y_up)
            mesh.metadata["name"] = part_id
            # Add default visual material
            mesh.visual = trimesh.visual.ColorVisuals(
                mesh=mesh,
                vertex_colors=np.full((len(mesh.vertices), 4), [180, 190, 205, 255], dtype=np.uint8),
            )

            scene.add_geometry(mesh, geom_name=part_id, node_name=part_id)

        except Exception as exc:
            errors_logged.append(f"{part_id} mesh packing failed: {exc}")

    if not components or len(scene.geometry) == 0:
        details = "\n".join(errors_logged[:5])
        raise IfcProcessingError(
            f"No displayable 3D geometry could be extracted from this uploaded IFC file.\n"
            f"Extraction diagnostic failures:\n{details}"
        )

    try:
        glb_data = scene.export(file_type="glb")
        with open(output_glb_path, "wb") as f:
            f.write(glb_data)
    except Exception as exc:
        raise IfcProcessingError(f"Failed to export GLB via trimesh: {exc}") from exc

    logger.info("Uploaded IFC successfully converted: %d parts, %d bytes GLB", len(components), len(glb_data))
    return {"solid_count": len(components), "components": components}