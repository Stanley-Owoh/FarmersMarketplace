import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { add, mul, formatXlm } from '../utils/money';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export default function Subscriptions() {
  const { user } = useAuth();
  const [subscriptions, setSubscriptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        const res = await fetch(`${API_URL}/api/subscriptions`, {
          headers: { Authorization: `Bearer ${user?.token}` },
        });
        if (!res.ok) throw new Error('Failed to load subscriptions');
        const data = await res.json();
        if (!cancelled) setSubscriptions(data.subscriptions || []);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [user?.token]);

  if (loading) return <div className="p-6">Loading subscriptions…</div>;
  if (error) return <div className="p-6 text-red-600">{error}</div>;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Subscriptions</h1>
      {subscriptions.length === 0 ? (
        <p className="text-gray-500">You have no active subscriptions.</p>
      ) : (
        <ul className="space-y-4">
          {subscriptions.map((sub) => {
            const total = mul(sub.product_price, sub.quantity);
            return (
              <li
                key={sub.id}
                className="border rounded-lg p-4 flex items-center justify-between"
              >
                <div>
                  <p className="font-semibold">{sub.product_name}</p>
                  <p className="text-sm text-gray-500">
                    {formatXlm(sub.product_price)} XLM × {sub.quantity}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-mono">{formatXlm(total)} XLM</p>
                  <Link
                    to={`/subscriptions/${sub.id}`}
                    className="text-sm text-blue-600 hover:underline"
                  >
                    Manage
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
