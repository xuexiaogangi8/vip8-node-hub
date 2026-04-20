BEGIN TRANSACTION;
-- 将未开通 (not_started) 和已到期 (expired) 的订阅状态改为 closed
UPDATE subscriptions SET status = 'closed' WHERE status IN ('not_started','expired');
COMMIT;