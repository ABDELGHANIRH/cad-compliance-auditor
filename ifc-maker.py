"""
generate_skid_plant.py

Generates a simplified industrial process skid (pipes, tanks, pumps, steel frame)
in IFC4 format using IfcOpenShell.
"""

import ifcopenshell
import ifcopenshell.api


def create_skid_ifc(output_file: str = "skid_plant.ifc"):
    # 1. Initialize empty IFC4 model
    model = ifcopenshell.api.run("project.create_file", version="IFC4")

    # 2. Project & Metric Units (Meters)
    project = ifcopenshell.api.run(
        "root.create_entity", model, ifc_class="IfcProject", name="IndustrialSkidProject"
    )
    ifcopenshell.api.run("unit.assign_unit", model, length={"is_metric": True, "raw": "METERS"})

    # 3. Geometric representation contexts
    context = ifcopenshell.api.run("context.add_context", model, context_type="Model")
    body_context = ifcopenshell.api.run(
        "context.add_context",
        model,
        context_type="Model",
        context_identifier="Body",
        target_view="MODEL_VIEW",
        parent=context,
    )

    # 4. Spatial hierarchy
    site = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcSite", name="Industrial Plant")
    ifcopenshell.api.run("aggregate.assign_object", model, relating_object=project, products=[site])

    building = ifcopenshell.api.run(
        "root.create_entity", model, ifc_class="IfcBuilding", name="Process Unit 1"
    )
    ifcopenshell.api.run("aggregate.assign_object", model, relating_object=site, products=[building])

    storey = ifcopenshell.api.run(
        "root.create_entity", model, ifc_class="IfcBuildingStorey", name="Skid Floor"
    )
    ifcopenshell.api.run("aggregate.assign_object", model, relating_object=building, products=[storey])

    # 5. Materials / Surface Styles (Color palette)
    styles = {}
    colors = {
        "SteelGray": (0.45, 0.47, 0.50),
        "TankCyan": (0.10, 0.65, 0.75),
        "PipeGreen": (0.15, 0.70, 0.35),
        "PipeBlue": (0.15, 0.45, 0.85),
        "PipeYellow": (0.90, 0.75, 0.15),
        "PumpNavy": (0.10, 0.20, 0.35),
        "PanelWhite": (0.92, 0.93, 0.95),
        "BaseSlab": (0.30, 0.32, 0.35),
    }

    for name, (r, g, b) in colors.items():
        color_rgb = model.createIfcColourRgb(None, r, g, b)
        rendering = model.createIfcSurfaceStyleRendering(
            SurfaceColour=color_rgb,
            ReflectanceMethod="NOTDEFINED",
        )
        style = model.createIfcSurfaceStyle(name, "BOTH", [rendering])
        styles[name] = style

    # Helper: Axis placement 3D
    def make_placement(location=(0.0, 0.0, 0.0), z_dir=(0.0, 0.0, 1.0), x_dir=(1.0, 0.0, 0.0)):
        point = model.createIfcCartesianPoint([float(v) for v in location])
        axis = model.createIfcDirection([float(v) for v in z_dir])
        ref_dir = model.createIfcDirection([float(v) for v in x_dir])
        return model.createIfcAxis2Placement3D(point, axis, ref_dir)

    # Helper: Extruded Cylinder
    def create_cylinder(radius, length, location, z_dir=(0.0, 0.0, 1.0), x_dir=(1.0, 0.0, 0.0)):
        profile = model.createIfcCircleProfileDef(
            ProfileType="AREA",
            Radius=float(radius),
            Position=model.createIfcAxis2Placement2D(
                model.createIfcCartesianPoint([0.0, 0.0]),
                model.createIfcDirection([1.0, 0.0]),
            ),
        )
        extrusion = model.createIfcExtrudedAreaSolid(
            SweptArea=profile,
            Position=make_placement(location, z_dir, x_dir),
            ExtrudedDirection=model.createIfcDirection([0.0, 0.0, 1.0]),
            Depth=float(length),
        )
        return extrusion

    # Helper: Extruded Box
    def create_box(dx, dy, dz, location):
        profile = model.createIfcRectangleProfileDef(
            ProfileType="AREA",
            XDim=float(dx),
            YDim=float(dy),
            Position=model.createIfcAxis2Placement2D(
                model.createIfcCartesianPoint([0.0, 0.0]),
                model.createIfcDirection([1.0, 0.0]),
            ),
        )
        extrusion = model.createIfcExtrudedAreaSolid(
            SweptArea=profile,
            Position=make_placement(location),
            ExtrudedDirection=model.createIfcDirection([0.0, 0.0, 1.0]),
            Depth=float(dz),
        )
        return extrusion

    # Helper: Register product with shape and assign to storey
    def add_element(ifc_class, name, solids, style_name, location=(0.0, 0.0, 0.0)):
        shape = model.createIfcShapeRepresentation(
            ContextOfItems=body_context,
            RepresentationIdentifier="Body",
            RepresentationType="SweptSolid",
            Items=solids,
        )

        product = ifcopenshell.api.run("root.create_entity", model, ifc_class=ifc_class, name=name)
        product.Representation = model.createIfcProductDefinitionShape(Representations=[shape])
        product.ObjectPlacement = model.createIfcLocalPlacement(None, make_placement(location))

        if style_name in styles:
            styled_item = model.createIfcStyledItem(Item=solids[0], Styles=[styles[style_name]])
            model.createIfcStyledRepresentation(
                ContextOfItems=body_context,
                Items=[styled_item],
            )

        ifcopenshell.api.run("spatial.assign_container", model, relating_structure=storey, products=[product])
        return product

    # -------------------------------------------------------------
    # 6. GEOMETRY GENERATION
    # -------------------------------------------------------------

    # A. Base Concrete/Steel Skid Slab (4.0m x 2.4m x 0.15m)
    slab_box = create_box(4.0, 2.4, 0.15, (2.0, 1.2, 0.0))
    add_element("IfcSlab", "Skid_Base_Platform", [slab_box], "BaseSlab")

    # B. Steel Frame Rack (4 vertical columns + 4 horizontal upper beams)
    frame_solids = []
    col_coords = [(0.2, 0.2), (3.8, 0.2), (3.8, 2.2), (0.2, 2.2)]
    col_h = 2.4
    col_thick = 0.08

    # Columns
    for cx, cy in col_coords:
        frame_solids.append(create_box(col_thick, col_thick, col_h, (cx, cy, 0.15)))

    # Upper perimeter beams
    frame_solids.append(create_box(3.6, col_thick, col_thick, (2.0, 0.2, 2.45)))
    frame_solids.append(create_box(3.6, col_thick, col_thick, (2.0, 2.2, 2.45)))
    frame_solids.append(create_box(col_thick, 2.0, col_thick, (0.2, 1.2, 2.45)))
    frame_solids.append(create_box(col_thick, 2.0, col_thick, (3.8, 1.2, 2.45)))

    add_element("IfcMember", "Steel_Frame_Rack", frame_solids, "SteelGray")

    # C. Vertical Pressure Vessels (Tanks T-101 and T-102)
    tank_coords = [(0.8, 1.6), (0.8, 0.8)]
    for idx, (tx, ty) in enumerate(tank_coords, start=1):
        tank_solids = [
            # Main cylindrical body
            create_cylinder(radius=0.28, length=1.2, location=(tx, ty, 0.35)),
            # Base support legs (cylinder)
            create_cylinder(radius=0.04, length=0.2, location=(tx - 0.15, ty, 0.15)),
            create_cylinder(radius=0.04, length=0.2, location=(tx + 0.15, ty, 0.15)),
        ]
        add_element("IfcFlowStorageDevice", f"Vessel_T-10{idx}", tank_solids, "TankCyan")

    # D. Centrifugal Pumps (P-101 and P-102)
    pump_coords = [(2.2, 0.7), (2.2, 1.5)]
    for idx, (px, py) in enumerate(pump_coords, start=1):
        pump_solids = [
            # Pump motor (horizontal cylinder)
            create_cylinder(
                radius=0.12,
                length=0.45,
                location=(px - 0.15, py, 0.32),
                z_dir=(1.0, 0.0, 0.0),
                x_dir=(0.0, 0.0, 1.0),
            ),
            # Pump casing volute
            create_cylinder(radius=0.18, length=0.15, location=(px + 0.32, py, 0.22)),
            # Support mount base
            create_box(0.65, 0.35, 0.10, (px + 0.1, py, 0.15)),
        ]
        add_element("IfcPump", f"Pump_P-10{idx}", pump_solids, "PumpNavy")

    # E. Process Piping Network
    pipe_green = [
        create_cylinder(radius=0.05, length=1.7, location=(1.08, 0.8, 0.6)),
        create_cylinder(
            radius=0.05,
            length=1.2,
            location=(1.08, 0.8, 2.3),
            z_dir=(1.0, 0.0, 0.0),
            x_dir=(0.0, 1.0, 0.0),
        ),
        create_cylinder(radius=0.04, length=1.9, location=(2.28, 0.8, 0.4)),
    ]
    add_element("IfcPipeSegment", "Process_Pipe_Green_DN80", pipe_green, "PipeGreen")

    pipe_blue = [
        create_cylinder(
            radius=0.06,
            length=3.4,
            location=(0.3, 1.2, 2.1),
            z_dir=(1.0, 0.0, 0.0),
            x_dir=(0.0, 1.0, 0.0),
        ),
        create_cylinder(radius=0.04, length=1.7, location=(2.5, 1.5, 0.4)),
    ]
    add_element("IfcPipeSegment", "Manifold_Pipe_Blue_DN100", pipe_blue, "PipeBlue")

    pipe_yellow = [
        create_cylinder(
            radius=0.04,
            length=3.4,
            location=(0.3, 1.4, 2.25),
            z_dir=(1.0, 0.0, 0.0),
            x_dir=(0.0, 1.0, 0.0),
        )
    ]
    add_element("IfcPipeSegment", "Bypass_Pipe_Yellow_DN50", pipe_yellow, "PipeYellow")

    # F. Local Control Cabinet / PLC Panel
    panel_solids = [
        create_box(0.18, 0.45, 0.60, (3.2, 0.25, 1.1)),
        create_cylinder(radius=0.025, length=0.8, location=(3.2, 0.25, 0.3)),
    ]
    add_element("IfcUnitaryControlElement", "Local_PLC_Panel_CP01", panel_solids, "PanelWhite")

    # 7. Write to file
    model.write(output_file)
    print(f"Generated {output_file} successfully.")


if __name__ == "__main__":
    create_skid_ifc("skid_plant.ifc")