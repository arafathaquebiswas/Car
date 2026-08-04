<?php
/**
 * Lightweight Standalone JWT Helper using SHA256 HMAC
 * Zero external vendor dependencies — 100% native PHP.
 */

function base64url_encode($data) {
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function base64url_decode($data) {
    return base64_decode(strtr($data, '-_', '+/') . str_repeat('=', (4 - strlen($data) % 4) % 4));
}

function jwt_encode($payload, $secret = JWT_SECRET) {
    $header = json_encode(['typ' => 'JWT', 'alg' => 'HS256']);
    $base64UrlHeader = base64url_encode($header);
    $base64UrlPayload = base64url_encode(json_encode($payload));
    $signature = hash_hmac('sha256', $base64UrlHeader . "." . $base64UrlPayload, $secret, true);
    $base64UrlSignature = base64url_encode($signature);
    return $base64UrlHeader . "." . $base64UrlPayload . "." . $base64UrlSignature;
}

function jwt_decode($jwt, $secret = JWT_SECRET) {
    $tokenParts = explode('.', $jwt);
    if (count($tokenParts) !== 3) return null;

    list($base64UrlHeader, $base64UrlPayload, $base64UrlSignature) = $tokenParts;

    $signature = base64url_decode($base64UrlSignature);
    $expectedSignature = hash_hmac('sha256', $base64UrlHeader . "." . $base64UrlPayload, $secret, true);

    if (!hash_equals($signature, $expectedSignature)) return null;

    $payload = json_decode(base64url_decode($base64UrlPayload), true);

    if (isset($payload['exp']) && $payload['exp'] < time()) return null;

    return $payload;
}
