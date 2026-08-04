const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");

// Builds the { getAll, create, remove } route handlers for one of the four
// simple reference lists (drivers, sirs, fuel types, stations), given its
// model (from simpleListModel.js) and a human-readable label for messages.
function createSimpleListController(model, label) {
  const getAll = asyncHandler(async (req, res) => {
    const items = await model.getAll();
    res.json({ success: true, data: items });
  });

  const create = asyncHandler(async (req, res) => {
    const name = (req.body.name || "").trim();
    if (!name) throw new ApiError(400, `${label} name is required.`);

    const existing = await model.findByName(name);
    if (existing) throw new ApiError(409, `${label} "${name}" already exists.`);

    const created = await model.create(name);
    res.status(201).json({ success: true, data: created });
  });

  const remove = asyncHandler(async (req, res) => {
    const existing = await model.findById(req.params.id);
    if (!existing) throw new ApiError(404, `${label} not found.`);
    await model.remove(req.params.id);
    res.json({ success: true, message: `${label} removed.` });
  });

  return { getAll, create, remove };
}

module.exports = { createSimpleListController };
