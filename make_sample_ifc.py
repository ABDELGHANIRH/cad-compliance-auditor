
import ifcopenshell
import ifcopenshell.api

# Initialize IFC4 model
model = ifcopenshell.file(schema="IFC4")

# Project hierarchy for a small building
project = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcProject", name="Small_Office_Plumbing")
ifcopenshell.api.run("unit.assign_unit", model)
context = ifcopenshell.api.run("context.add_context", model, context_type="Model")
body = ifcopenshell.api.run(
    "context.add_context", 
    model, 
    context_type="Model", 
    context_identifier="Body", 
    target_view="MODEL_VIEW", 
    parent=context
)

site = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcSite", name="Commercial_Site")
building = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcBuilding", name="Office_Block_A")
storey = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcBuildingStorey", name="Level_01_Utility_Room")

ifcopenshell.api.run("aggregate.assign_object", model, relating_object=project, products=[site])
ifcopenshell.api.run("aggregate.assign_object", model, relating_object=site, products=[building])
ifcopenshell.api.run("aggregate.assign_object", model, relating_object=building, products=[storey])

# Geometry Helpers
def create_cylinder_mesh(x, y, z, radius, length, dir_x=0.0, dir_y=0.0, dir_z=1.0):
    point = model.createIfcCartesianPoint((float(x), float(y), float(z)))
    axis = model.createIfcAxis2Placement3D(point, model.createIfcDirection((float(dir_x), float(dir_y), float(dir_z))), None)
    profile = model.createIfcCircleProfileDef("AREA", None, None, float(radius))
    solid = model.createIfcExtrudedAreaSolid(profile, axis, model.createIfcDirection((0.0, 0.0, 1.0)), float(length))
    shape = model.createIfcShapeRepresentation(body, "Body", "SweptSolid", [solid])
    return model.createIfcProductDefinitionShape(None, None, [shape])

def create_box_mesh(x, y, z, dx, dy, dz):
    point = model.createIfcCartesianPoint((float(x), float(y), float(z)))
    axis = model.createIfcAxis2Placement3D(point, None, None)
    profile = model.createIfcRectangleProfileDef("AREA", None, None, float(dx), float(dy))
    solid = model.createIfcExtrudedAreaSolid(profile, axis, model.createIfcDirection((0.0, 0.0, 1.0)), float(dz))
    shape = model.createIfcShapeRepresentation(body, "Body", "SweptSolid", [solid])
    return model.createIfcProductDefinitionShape(None, None, [shape])

# 1. Main Vertical Riser Pipe (Compliant DN80: 88.9 mm OD -> Radius 45 mm)
riser = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcPipeSegment", name="Riser_Pipe_Main_01")
riser.Representation = create_cylinder_mesh(0, 0, 0, radius=45, length=2400, dir_x=0, dir_y=0, dir_z=1)
ifcopenshell.api.run("spatial.assign_container", model, relating_structure=storey, products=[riser])
pset_riser = ifcopenshell.api.run("pset.add_pset", model, product=riser, name="Pset_PipeSegmentTypeCommon")
ifcopenshell.api.run("pset.edit_pset", model, pset=pset_riser, properties={
    "Material": "Copper Type L",
    "NominalDiameter": "80.0",
    "ServiceType": "Domestic Cold Water Supply"
})

# 2. 90-Degree Elbow Transition Fitting at 2000 mm elevation
elbow = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcFlowFitting", name="Elbow_90Deg_DN80")
elbow.Representation = create_box_mesh(0, 0, 2000, 110, 110, 110)
ifcopenshell.api.run("spatial.assign_container", model, relating_structure=storey, products=[elbow])
pset_elbow = ifcopenshell.api.run("pset.add_pset", model, product=elbow, name="Pset_FittingCommon")
ifcopenshell.api.run("pset.edit_pset", model, pset=pset_elbow, properties={
    "Material": "Bronze",
    "Angle": "90.0"
})

# 3. Horizontal Branch Distribution Pipe (NON-COMPLIANT: 32 mm OD instead of 65 mm required by spec)
branch = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcPipeSegment", name="Branch_Distribution_Line_A")
branch.Representation = create_cylinder_mesh(0, 50, 2000, radius=16, length=1800, dir_x=0, dir_y=1, dir_z=0)
ifcopenshell.api.run("spatial.assign_container", model, relating_structure=storey, products=[branch])
pset_branch = ifcopenshell.api.run("pset.add_pset", model, product=branch, name="Pset_PipeSegmentTypeCommon")
ifcopenshell.api.run("pset.edit_pset", model, pset=pset_branch, properties={
    "Material": "Copper Type M",
    "NominalDiameter": "32.0",
    "Schedule": "Light Duty"
})

# 4. Inline Isolation Ball Valve on Branch
valve = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcValve", name="Branch_Isolation_Valve_V101")
valve.Representation = create_box_mesh(0, 600, 2000, 90, 120, 90)
ifcopenshell.api.run("spatial.assign_container", model, relating_structure=storey, products=[valve])
pset_valve = ifcopenshell.api.run("pset.add_pset", model, product=valve, name="Pset_ValveTypeCommon")
ifcopenshell.api.run("pset.edit_pset", model, pset=pset_valve, properties={
    "Material": "Brass",
    "ValveType": "BALL",
    "PressureRating": "PN16"
})

# 5. Pressure Booster Pump / In-line unit
pump = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcEnergyConversionDevice", name="Booster_Pump_P1")
pump.Representation = create_box_mesh(-80, 1200, 1950, 220, 300, 200)
ifcopenshell.api.run("spatial.assign_container", model, relating_structure=storey, products=[pump])
pset_pump = ifcopenshell.api.run("pset.add_pset", model, product=pump, name="Pset_PumpCommon")
ifcopenshell.api.run("pset.edit_pset", model, pset=pset_pump, properties={
    "Manufacturer": "Grundfos / Standard",
    "Status": "Operational"
})

output_path = "sample_skid.ifc"
model.write(output_path)
print(f"Generated realistic small building piping layout: {output_path}")