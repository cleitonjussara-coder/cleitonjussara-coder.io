<?php

/* Ajustes do Petermann App que não são do framework. Tudo vem do .env. */
return [

    /* Endereço do app (a PWA). É para onde o login Google e o link de
       redefinição de senha mandam a pessoa de volta. Sem barra no fim. */
    'front_url' => rtrim(env('FRONT_URL', 'https://app.pmservicosagronomicos.com.br/rda-rdm-app'), '/'),

    /* E-mail da solicitação de repasse (antes: gatilho enviar_email_repasse). */
    'repasse' => [
        'from' => env('REPASSE_EMAIL_FROM', 'Petermann App <app@pmservicosagronomicos.com.br>'),
        'to' => env('REPASSE_EMAIL_TO', 'repasse@pmservicosagronomicos.com.br'),
    ],

    /* Login com Google (mesmo cliente OAuth do projeto CLEITON-PM). A URL de
       callback precisa estar cadastrada lá em "URIs de redirecionamento". */
    'google' => [
        'client_id' => env('GOOGLE_CLIENT_ID'),
        'client_secret' => env('GOOGLE_CLIENT_SECRET'),
    ],

    /* Aviso de erro por e-mail (20/09/2026): exceções da API e falha do
       backup. Sem ALERTA_EMAIL_TO, vai para o e-mail do repasse; aceita
       vários endereços separados por vírgula. */
    'alerta' => [
        'to' => env('ALERTA_EMAIL_TO') ?: env('REPASSE_EMAIL_TO', 'repasse@pmservicosagronomicos.com.br'),
        'intervalo' => (int) env('ALERTA_INTERVALO', 3600),   // segundos entre avisos do MESMO erro
        'max_dia' => (int) env('ALERTA_MAX_DIA', 20),
    ],

    /* Validade das URLs assinadas dos anexos (segundos). O app pedia 300 ao
       Supabase; mantido. */
    'foto_url_ttl' => (int) env('FOTO_URL_TTL', 300),

    /* Tamanho máximo do anexo em KB (fotos de cupom passam longe de 20 MB;
       o limite real da hospedagem é o upload_max_filesize do PHP). */
    'foto_max_kb' => (int) env('FOTO_MAX_KB', 20480),

    /* Só para desenvolvimento no Windows (curl do PHP sem CA): caminho de um
       ca-bundle.crt. Em produção fica vazio e o PHP usa o do sistema. */
    'ca_bundle' => env('CA_BUNDLE'),
];
