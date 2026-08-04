<?php
/**
 * Standalone Photo Retention Cron Job for Hostinger Shared Hosting
 *
 * Configured in Hostinger hPanel -> Cron Jobs:
 * Command: php /home/uXXXXXXXX/domains/atmabiswas.org/public_html/fuel/cron/photo_retention.php
 * Schedule: Once daily (0 0 * * *)
 */

require_once __DIR__ . '/../api/config.php';

$pdo = get_db();

echo "[" . date('Y-m-d H:i:s') . "] Starting Photo Retention Purge job...\n";

$sql = "SELECT id, record_code, driver_id, fuel_receipt_image, money_receipt_image, vehicle_photo_image
        FROM fuel_records
        WHERE created_at < (NOW() - INTERVAL 90 DAY)
          AND (fuel_receipt_image IS NOT NULL OR money_receipt_image IS NOT NULL OR vehicle_photo_image IS NOT NULL)";

$stmt = $pdo->query($sql);
$rows = $stmt->fetchAll();

$recordsPurged = 0;
$filesDeleted = 0;

foreach ($rows as $row) {
    $colsToNull = [];
    $types = [];

    $photos = [
        'fuel_receipt_image'  => 'Fuel Machine Photo',
        'money_receipt_image' => 'Money Receipt Photo',
        'vehicle_photo_image' => 'Dashboard/Odometer Photo',
    ];

    foreach ($photos as $col => $label) {
        if ($row[$col]) {
            $filePath = __DIR__ . '/..' . $row[$col];
            if (file_exists($filePath)) {
                unlink($filePath);
                $filesDeleted++;
            }
            $colsToNull[] = "{$col} = NULL";
            $types[] = $label;
        }
    }

    if (!empty($colsToNull)) {
        $updateSql = "UPDATE fuel_records SET " . implode(', ', $colsToNull) . " WHERE id = ?";
        $uStmt = $pdo->prepare($updateSql);
        $uStmt->execute([$row['id']]);

        $hStmt = $pdo->prepare("INSERT INTO approval_history (record_id, action, performed_by, note) VALUES (?, 'Photo Retention Purge', 'System', ?)");
        $note = "📷 Photo evidence has been removed according to the 90-day retention policy.";
        $hStmt->execute([$row['id'], $note]);

        // Send notification to driver if linked user exists
        $dUserId = $pdo->query("SELECT id FROM users WHERE driver_id = " . (int)($row['driver_id'] ?? 0))->fetchColumn();
        if ($dUserId) {
            create_notification($dUserId, 'Photo Evidence Removed', "📷 Photo evidence has been removed according to the 90-day retention policy.", 'info', $row['record_code']);
        }

        $recordsPurged++;
    }
}

echo "[" . date('Y-m-d H:i:s') . "] Photo Retention Purge completed. Records purged: {$recordsPurged}, Files deleted: {$filesDeleted}\n";
