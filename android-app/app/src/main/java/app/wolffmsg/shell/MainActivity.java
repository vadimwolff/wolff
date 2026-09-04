package app.wolffmsg.shell;

/* ==========================================================================
 *  Единственный экран приложения.
 *
 *  Интерфейс лежит внутри пакета — в assets/www, — и открывается не как файл
 *  с диска, а через WebViewAssetLoader: тот отдаёт локальные файлы по адресу
 *  https://appassets.androidplatform.net/. Это важно, иначе браузерный движок
 *  считает страницу небезопасной и отключает шифрование (crypto.subtle),
 *  хранилище и запросы к серверу.
 *
 *  Наружу приложение ходит только за перепиской: сам экран рисуется мгновенно
 *  и без интернета.
 * ========================================================================== */

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.webkit.WebViewAssetLoader;

public class MainActivity extends AppCompatActivity {

    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String START = ORIGIN + "/assets/www/index.html";
    private static final int FILE_REQUEST = 101;
    private static final int PERMISSION_REQUEST = 102;

    private WebView web;
    private ValueCallback<Uri[]> filePicker;

    @Override
    protected void onCreate(@Nullable Bundle saved) {
        super.onCreate(saved);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        setContentView(web);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);   // голосовые и гифки играют сами
        settings.setSupportMultipleWindows(false);
        settings.setAllowFileAccess(false);                    // файлы отдаёт только loader
        settings.setAllowContentAccess(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (url.toString().startsWith(ORIGIN)) return false;
                // Ссылки из переписки открываем в браузере, а не внутри приложения.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (ActivityNotFoundException e) {
                    return false;
                }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // Микрофон и камера нужны голосовым и звонкам. Разрешение у
                // системы уже спрошено при запуске, здесь только подтверждаем.
                runOnUiThread(new Runnable() {
                    @Override public void run() { request.grant(request.getResources()); }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePicker != null) filePicker.onReceiveValue(null);
                filePicker = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_REQUEST);
                } catch (ActivityNotFoundException e) {
                    filePicker = null;
                    return false;
                }
                return true;
            }
        });

        askPermissions();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                // Кнопка «назад» ходит по экранам приложения, как на телефоне.
                if (web.canGoBack()) web.goBack();
                else finish();
            }
        });

        if (saved != null) web.restoreState(saved);
        else web.loadUrl(START);
    }

    private void askPermissions() {
        String[] needed = { Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA };
        for (String permission : needed) {
            if (ContextCompat.checkSelfPermission(this, permission) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, needed, PERMISSION_REQUEST);
                return;
            }
        }
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onActivityResult(int request, int result, @Nullable Intent data) {
        super.onActivityResult(request, result, data);
        if (request != FILE_REQUEST || filePicker == null) return;
        filePicker.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
        filePicker = null;
    }
}
