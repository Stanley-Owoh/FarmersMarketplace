const express = require('express');
const db = require('../db/schema');
const auth = require('../middleware/auth');
const { err } = require('../middleware/error');
const validate = require('../middleware/validate');
const { sanitizeText } = require('../utils/sanitize');

const router = express.Router();
const adminRouter = express.Router();
const productRouter = express.Router();

async function recalcRating(productId) {
  const { rows } = await db.query(
    `SELECT ROUND(AVG(rating), 2) AS avg, COUNT(*) AS cnt
     FROM reviews WHERE product_id = $1 AND status = 'approved'`,
    [productId]
  );
  const row = rows[0];
  await db.query('UPDATE products SET avg_rating = $1, review_count = $2 WHERE id = $3', [
    row.avg || 0,
    row.cnt || 0,
    productId,
  ]);
}

router.get('/:productId', async (req, res) => {
  const { rows } = await db.query(
    `SELECT r.id, r.rating, r.comment AS body, r.created_at, u.name AS buyer_name
     FROM reviews r JOIN users u ON r.buyer_id = u.id
     WHERE r.product_id = $1 AND r.status = 'approved'
     ORDER BY r.created_at DESC`,
    [req.params.productId]
  );
  res.json({ success: true, data: rows });
});

adminRouter.patch('/:id/approve', auth, async (req, res) => {
  if (req.user.role !== 'admin') return err(res, 403, 'Admins only', 'forbidden');
  const { rows } = await db.query('SELECT * FROM reviews WHERE id = $1', [req.params.id]);
  const review = rows[0];
  if (!review) return err(res, 404, 'Review not found', 'not_found');

  await db.query("UPDATE reviews SET status = 'approved' WHERE id = $1", [req.params.id]);
  await recalcRating(review.product_id);
  res.json({ success: true, message: 'Review approved' });
});

adminRouter.patch('/:id/reject', auth, async (req, res) => {
  if (req.user.role !== 'admin') return err(res, 403, 'Admins only', 'forbidden');
  const { rows } = await db.query('SELECT * FROM reviews WHERE id = $1', [req.params.id]);
  const review = rows[0];
  if (!review) return err(res, 404, 'Review not found', 'not_found');

  await db.query("UPDATE reviews SET status = 'rejected' WHERE id = $1", [req.params.id]);
  await recalcRating(review.product_id);
  res.json({ success: true, message: 'Review rejected' });
});

adminRouter.get('/pending', auth, async (req, res) => {
  if (req.user.role !== 'admin') return err(res, 403, 'Admins only', 'forbidden');
  const { rows } = await db.query(
    `SELECT r.*, u.name AS buyer_name, p.name AS product_name
     FROM reviews r
     JOIN users u ON r.buyer_id = u.id
     JOIN products p ON r.product_id = p.id
     WHERE r.status = 'pending'
     ORDER BY r.created_at ASC`
  );
  res.json({ success: true, data: rows });
});

router.delete('/:id', auth, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM reviews WHERE id = $1 AND buyer_id = $2', [
    req.params.id,
    req.user.id,
  ]);
  const review = rows[0];
  if (!review) return err(res, 404, 'Review not found or not yours', 'not_found');

  await db.query('DELETE FROM reviews WHERE id = $1', [req.params.id]);
  await recalcRating(review.product_id);
  res.json({ success: true, message: 'Review deleted' });
});

router.post('/', auth, validate.review, async (req, res) => {
  if (req.user.role !== 'buyer')
    return err(res, 403, 'Only buyers can submit reviews', 'forbidden');

  const productId = parseInt(req.body.product_id, 10);
  const rating = parseInt(req.body.rating, 10);
  const comment = req.body.comment ? sanitizeText(req.body.comment) : null;

  const { rows: orderRows } = await db.query(
    `SELECT id FROM orders WHERE buyer_id = $1 AND product_id = $2 AND status = 'paid' LIMIT 1`,
    [req.user.id, productId]
  );
  if (!orderRows[0])
    return err(res, 403, 'Purchase required to review this product', 'purchase_required');

  const { rows: existingReviews } = await db.query(
    'SELECT id FROM reviews WHERE order_id = $1',
    [orderRows[0].id]
  );
  if (existingReviews[0])
    return err(res, 409, 'You have already reviewed this order', 'duplicate_review');

  const { rows } = await db.query(
    'INSERT INTO reviews (order_id, buyer_id, product_id, rating, comment) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [orderRows[0].id, req.user.id, productId, rating, comment]
  );
  res.status(201).json({ success: true, id: rows[0].id, message: 'Review submitted' });
});

productRouter.get('/:id/reviews', async (req, res) => {
  const { rows } = await db.query(
    `SELECT r.id, r.rating, r.comment, r.created_at, u.name AS reviewer_name
     FROM reviews r JOIN users u ON r.buyer_id = u.id
     WHERE r.product_id = $1 ORDER BY r.created_at DESC`,
    [req.params.id]
  );
  res.json({ success: true, data: rows });
});

router.adminRouter = adminRouter;
router.productRouter = productRouter;

module.exports = router;
