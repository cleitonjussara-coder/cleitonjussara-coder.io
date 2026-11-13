<?php

namespace Tests;

use Illuminate\Foundation\Testing\TestCase as BaseTestCase;

abstract class TestCase extends BaseTestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        /* 12/11/2026: Storage::fake grava em storage_path('framework/testing/disks'). Dentro da pasta do OneDrive, o
           OneDrive (ou o antivírus) segura a foto recém-gravada e o rename do FotoStorage dá "Acesso negado (code: 5)":
           o publicar.sh reprovou ~150 testes de anexo sem nada errado no código. Os arquivos dos testes ficam na pasta
           temporária do sistema, fora de qualquer pasta sincronizada. No servidor (Linux) nada muda. */
        $dir = sys_get_temp_dir().DIRECTORY_SEPARATOR.'notas-pm-testes';
        if (! is_dir($dir)) {
            @mkdir($dir, 0777, true);
        }
        $this->app->useStoragePath($dir);
        /* teste que não chama Storage::fake('fotos') usaria o disco real, já resolvido dentro da pasta do projeto */
        config(['filesystems.disks.fotos.root' => $dir.DIRECTORY_SEPARATOR.'app'.DIRECTORY_SEPARATOR.'fotos']);
        \Illuminate\Support\Facades\Storage::forgetDisk('fotos');
    }
}
