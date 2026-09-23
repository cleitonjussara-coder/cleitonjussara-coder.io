<?php

namespace App\Services;

use App\Models\Nota;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use InvalidArgumentException;

/**
 * Anexos das notas no DISCO do servidor. O MySQL guarda apenas o caminho
 * relativo (notas.foto_path); o binário nunca entra no banco.
 *
 * Caminho determinístico, igual ao que o Storage do Supabase usava:
 *   <user_id>/<nota_id>.<ext>
 * É o que permite reconectar uma nota ao arquivo dela só pelo id
 * (repararOrfas) e organizar a pasta por colaborador.
 */
class FotoStorage
{
    public const EXTS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'gif', 'pdf', 'xml'];

    public const MIME = [
        'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png',
        'webp' => 'image/webp', 'heic' => 'image/heic', 'gif' => 'image/gif',
        'pdf' => 'application/pdf', 'xml' => 'application/xml',
    ];

    public function disk(): Filesystem
    {
        return Storage::disk('fotos');
    }

    /** Extensão normalizada a partir do nome/MIME do arquivo enviado. */
    public function extensaoDe(UploadedFile $file, ?string $hint = null): string
    {
        $ext = strtolower($hint ?: ($file->getClientOriginalExtension() ?: ''));
        if ($ext === 'jpeg') {
            $ext = 'jpg';
        }
        if (! in_array($ext, self::EXTS, true)) {
            $mime = strtolower($file->getMimeType() ?: '');
            $ext = match (true) {
                $mime === 'application/pdf' => 'pdf',
                in_array($mime, ['text/xml', 'application/xml'], true) => 'xml',
                $mime === 'image/png' => 'png',
                $mime === 'image/webp' => 'webp',
                in_array($mime, ['image/heic', 'image/heif'], true) => 'heic',
                $mime === 'image/gif' => 'gif',
                default => 'jpg',
            };
        }

        return $ext;
    }

    public function caminho(Nota $nota, string $ext): string
    {
        return "{$nota->user_id}/{$nota->id}.{$ext}";
    }

    /** Grava o arquivo e devolve o caminho relativo a guardar em foto_path. */
    public function salvar(Nota $nota, UploadedFile $file, ?string $extHint = null): string
    {
        return $this->salvarPara($nota->user_id, $nota->id, $file, $extHint);
    }

    /** Idem, sem precisar da linha da nota (o anexo sobe antes dela existir). */
    public function salvarPara(string $userId, string $notaId, UploadedFile $file, ?string $extHint = null): string
    {
        $ext = $this->extensaoDe($file, $extHint);

        /* Troca de formato (jpg → pdf) não pode deixar o arquivo antigo para
           trás: o caminho muda e o velho viraria órfão para sempre. */
        $this->apagarVersoesDe($userId, $notaId);
        $this->disk()->putFileAs($userId, $file, "{$notaId}.{$ext}");
        /* 23/09/2026: rede de segurança. O app novo já manda a foto em pé,
           mas versão antiga (e qualquer outro cliente) manda o JPEG cru, com
           a rotação só no EXIF — e aí PDF, ZIP e planilha saem deitados. */
        $this->endireitar("{$userId}/{$notaId}.{$ext}");

        return "{$userId}/{$notaId}.{$ext}";
    }

    /**
     * Regrava o JPEG já rotacionado, sem o EXIF de orientação. Devolve true
     * se mexeu no arquivo. Serve na gravação e no mutirão das fotos antigas
     * (artisan fotos:endireitar).
     */
    public function endireitar(string $path): bool
    {
        $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        if (! in_array($ext, ['jpg', 'jpeg'], true) || ! $this->existe($path)) {
            return false;
        }
        if (! function_exists('imagecreatefromstring') || ! function_exists('exif_read_data')) {
            return false;
        }
        try {
            $bin = $this->disk()->get($path);
            $exif = @exif_read_data('data://image/jpeg;base64,'.base64_encode($bin));
            $o = (int) ($exif['Orientation'] ?? 1);
            if ($o <= 1) {
                return false;                 // já está em pé
            }
            $img = @imagecreatefromstring($bin);
            if (! $img) {
                return false;
            }
            $img = $this->corrigirOrientacao($img, $bin, $ext);
            ob_start();
            imagejpeg($img, null, 88);
            $jpg = ob_get_clean();
            imagedestroy($img);
            if (! $jpg) {
                return false;
            }
            $this->disk()->put($path, $jpg);
            $this->apagar($this->caminhoMini($path));   // miniatura velha some; nasce da foto certa

            return true;
        } catch (\Throwable) {
            return false;
        }
    }

    public function existe(?string $path): bool
    {
        return $path !== null && $path !== '' && $this->disk()->exists($path);
    }

    public function apagar(?string $path): void
    {
        if ($path && $this->disk()->exists($path)) {
            $this->disk()->delete($path);
        }
    }

    /** Remove qualquer <nota_id>.* da pasta do dono. */
    public function apagarTodasVersoes(Nota $nota): void
    {
        $this->apagarVersoesDe($nota->user_id, $nota->id);
    }

    public function apagarVersoesDe(string $userId, string $notaId): void
    {
        foreach ($this->disk()->files($userId) as $f) {
            if (pathinfo($f, PATHINFO_FILENAME) === $notaId) {
                $this->disk()->delete($f);
            }
        }
        $this->apagar("{$userId}/".self::MINI_DIR."/{$notaId}.jpg");
    }

    /* ── Miniaturas (19/09/2026) ────────────────────────────────────
       A tela Arquivos lista dezenas de notas de uma vez; servir a foto
       inteira (~1 MB) em cada quadradinho travaria no 4G. A miniatura
       (lado maior 360 px, ~20 KB) fica em <user_id>/mini/<nota_id>.jpg,
       gerada no upload e, se faltar, na primeira vez que alguém pede.
       Só imagens que o GD decodifica (jpg/png/gif/webp); PDF/HEIC → null. */
    public const MINI_DIR = 'mini';

    public const MINI_LADO = 360;

    public function caminhoMini(string $path): string
    {
        [$user, $arq] = explode('/', $path, 2);

        return "{$user}/".self::MINI_DIR.'/'.pathinfo($arq, PATHINFO_FILENAME).'.jpg';
    }

    /** Caminho da miniatura pronta (gera se faltar) ou null se não dá para gerar. */
    public function miniatura(string $path): ?string
    {
        $mini = $this->caminhoMini($path);
        if ($this->disk()->exists($mini)) {
            return $mini;
        }
        if (! function_exists('imagecreatefromstring') || ! $this->existe($path)) {
            return null;
        }
        $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        if (! in_array($ext, ['jpg', 'jpeg', 'png', 'gif', 'webp'], true)) {
            return null;
        }
        try {
            $bin = $this->disk()->get($path);
            $img = @imagecreatefromstring($bin);
            if (! $img) {
                return null;
            }
            $img = $this->corrigirOrientacao($img, $bin, $ext);
            $w = imagesx($img);
            $h = imagesy($img);
            $escala = min(1, self::MINI_LADO / max($w, $h, 1));
            $nw = max(1, (int) round($w * $escala));
            $nh = max(1, (int) round($h * $escala));
            $out = imagecreatetruecolor($nw, $nh);
            $branco = imagecolorallocate($out, 255, 255, 255);   // png transparente → fundo branco
            imagefill($out, 0, 0, $branco);
            imagecopyresampled($out, $img, 0, 0, 0, 0, $nw, $nh, $w, $h);
            ob_start();
            imagejpeg($out, null, 72);
            $jpg = ob_get_clean();
            imagedestroy($out);
            imagedestroy($img);
            if ($jpg === '' || $jpg === false) {
                return null;
            }
            $this->disk()->put($mini, $jpg);

            return $mini;
        } catch (\Throwable) {
            return null;
        }
    }

    /** Foto de celular vem "deitada" com a orientação só no EXIF; sem isto a miniatura sai girada. */
    private function corrigirOrientacao(\GdImage $img, string $bin, string $ext): \GdImage
    {
        if (! in_array($ext, ['jpg', 'jpeg'], true) || ! function_exists('exif_read_data')) {
            return $img;
        }
        try {
            $exif = @exif_read_data('data://image/jpeg;base64,'.base64_encode($bin));
            $o = (int) ($exif['Orientation'] ?? 1);
        } catch (\Throwable) {
            return $img;
        }
        $rot = match ($o) { 3 => 180, 6 => -90, 8 => 90, default => 0 };
        if ($rot === 0) {
            return $img;
        }
        $r = imagerotate($img, $rot, 0);
        if ($r) {
            imagedestroy($img);

            return $r;
        }

        return $img;
    }

    /**
     * Nome do arquivo da nota na pasta do dono, se existir (sem depender de
     * foto_path). Usado para reconectar notas que perderam a referência.
     */
    public function arquivoDaNota(string $userId, string $notaId): ?string
    {
        foreach ($this->disk()->files($userId) as $f) {
            if (pathinfo($f, PATHINFO_FILENAME) === $notaId) {
                return $f;
            }
        }

        return null;
    }

    public function mimeDe(string $path): string
    {
        $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));

        return self::MIME[$ext] ?? 'application/octet-stream';
    }

    /** Rejeita qualquer tentativa de sair da pasta de fotos ("../", absoluto). */
    public function validarCaminho(string $path): string
    {
        $path = str_replace('\\', '/', trim($path));
        if ($path === '' || str_contains($path, '..') || str_starts_with($path, '/')
            || ! preg_match('#^[A-Za-z0-9\-]+/(mini/)?[A-Za-z0-9\-]+\.[a-z0-9]+$#', $path)) {
            throw new InvalidArgumentException('Caminho de anexo inválido');
        }

        return $path;
    }
}
