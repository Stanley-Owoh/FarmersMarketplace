const { writeAuditLog } = require("../utils/auditLog");

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

module.exports = function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized." });
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin access required." });

  if (STATE_CHANGING_METHODS.has(req.method)) {
    writeAuditLog({
      actorId: req.user.id,
      action: `${req.method} ${req.baseUrl || ""}${req.path}`,
      targetType: "admin_route",
      targetId: req.params && req.params.id ? req.params.id : null,
      metadata: { ip: req.ip },
    }).catch(() => {});
  }

  next();
};
