<?php
// PorterClaude php recipe — placeholder document root. OWNER: O1.
// Replace freely: this file lives at /workspace/public/index.php inside the session,
// which is the session's workspace volume (nginx root = /workspace/public).
header('Content-Type: text/plain; charset=utf-8');
$session = getenv('PORTERCLAUDE_SESSION') ?: 'unknown';
echo "PorterClaude php recipe\n";
echo 'PHP      ' . PHP_VERSION . "\n";
echo 'session  ' . $session . "\n";
echo "source   /workspace/public/index.php\n";
