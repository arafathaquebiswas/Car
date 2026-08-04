<?php
/**
 * Hostinger Shared Hosting Database & Environment Configuration
 */

// Set time zone
date_default_timezone_set('Asia/Dhaka');

// Helper to parse simple .env file if present
function load_dotenv($path) {
    if (!file_exists($path)) return;
    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines as $line) {
        if (strpos(trim($line), '#') === 0) continue;
        if (strpos($line, '=') !== false) {
            list($name, $value) = explode('=', $line, 2);
            $name = trim($name);
            $value = trim(trim($value), '"\'');
            if (!array_key_exists($name, $_SERVER) && !array_key_exists($name, $_ENV)) {
                putenv("{$name}={$value}");
                $_ENV[$name] = $value;
                $_SERVER[$name] = $value;
            }
        }
    }
}

// Load .env from root directory if it exists
load_dotenv(__DIR__ . '/../.env');

$db_host = getenv('DB_HOST') ?: 'localhost';
$db_port = getenv('DB_PORT') ?: '3306';
$db_user = getenv('DB_USER') ?: 'root';
$db_pass = getenv('DB_PASSWORD') ?: '';
$db_name = getenv('DB_NAME') ?: 'fuel_station';

define('JWT_SECRET', getenv('JWT_SECRET') ?: 'replace-this-with-a-long-random-string');
define('JWT_EXPIRES_IN', 8 * 3600); // 8 hours in seconds
define('MAX_UPLOAD_BYTES', ((int)(getenv('MAX_UPLOAD_MB') ?: 12)) * 1024 * 1024);

function get_db() {
    static $pdo = null;
    global $db_host, $db_port, $db_user, $db_pass, $db_name;
    if ($pdo === null) {
        $dsn = "mysql:host={$db_host};port={$db_port};dbname={$db_name};charset=utf8mb4";
        $options = [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ];
        try {
            $pdo = new PDO($dsn, $db_user, $db_pass, $options);
        } catch (PDOException $e) {
            http_response_code(500);
            header('Content-Type: application/json');
            echo json_encode(['success' => false, 'message' => 'Database connection failed. Please check .env credentials.']);
            exit;
        }
    }
    return $pdo;
}
