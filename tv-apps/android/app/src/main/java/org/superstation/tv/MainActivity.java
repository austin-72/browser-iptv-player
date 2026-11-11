package org.superstation.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;

/**
 * The whole app: a full-screen WebView that opens your server's address, asked for once and remembered.
 * Everything you see after that is the server's own pages, exactly as in a browser.
 *
 *  - The remote's arrows and OK reach the page as arrow keys and Enter; Back is handed to the page as the "back"
 *    key TVs send (the page closes a menu, goes back, or, at Home, leaves the app through TvApp.exit()).
 *  - Menu on the remote, or holding Back, asks for the server's address again.
 *  - A video made full screen by the page is shown full screen.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "app";
    private static final String KEY_SERVER = "server";

    private FrameLayout root;
    private WebView web;
    private View fullView;
    private WebChromeClient.CustomViewCallback fullCallback;
    private boolean asking;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(11, 13, 18));
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(11, 13, 18));
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        // (An https server with plain-http streams from a provider: allowed, as the page asks a desktop browser to.)
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        // (So the pages know it's a TV and use their big, remote-friendly layout.)
        s.setUserAgentString(s.getUserAgentString() + " Android TV SuperstationTV/1.0");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new Bridge(), "TvApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false; // (everything opens here: there is no other browser to send it to on a TV)
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // The server itself didn't answer (not one picture or stream of a page that did).
                if (request.isForMainFrame()) askAddress(getString(R.string.err_unreachable, request.getUrl().toString()));
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                // (Android 5: the older form of the same.)
                if (Build.VERSION.SDK_INT < 23 && failingUrl != null && failingUrl.equals(view.getUrl())) askAddress(getString(R.string.err_unreachable, failingUrl));
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullView != null) { callback.onCustomViewHidden(); return; }
                fullView = view;
                fullCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                web.setVisibility(View.GONE);
            }

            @Override
            public void onHideCustomView() {
                leaveFullScreen();
            }
        });

        if (saved != null) {
            web.restoreState(saved);
        } else {
            String url = prefs().getString(KEY_SERVER, "");
            if (url.isEmpty()) askAddress(null); else web.loadUrl(url);
        }
        web.requestFocus();
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private void leaveFullScreen() {
        if (fullView == null) return;
        root.removeView(fullView);
        fullView = null;
        web.setVisibility(View.VISIBLE);
        if (fullCallback != null) fullCallback.onCustomViewHidden();
        fullCallback = null;
        web.requestFocus();
    }

    /** "192.168.1.20:8080" → "http://192.168.1.20:8080"; "" when it isn't an address. */
    static String tidy(String v) {
        v = v == null ? "" : v.trim();
        while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
        if (v.isEmpty()) return "";
        if (!v.matches("(?i)^https?://.*")) v = "http://" + v;
        return v.matches("(?i)^https?://[^\\s/?#]+(/\\S*)?$") ? v : "";
    }

    /** The one question this app asks: the server's address. */
    private void askAddress(String message) {
        if (asking || isFinishing()) return;
        asking = true;
        final EditText box = new EditText(this);
        box.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        box.setSingleLine(true);
        box.setHint(R.string.ask_hint);
        box.setText(prefs().getString(KEY_SERVER, ""));
        box.setSelection(box.getText().length());
        final boolean first = prefs().getString(KEY_SERVER, "").isEmpty();
        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle(R.string.ask_title)
                .setMessage(message != null ? message : getString(R.string.ask_message))
                .setView(box)
                .setCancelable(!first)
                .setPositiveButton(R.string.ask_open, (d, w) -> {
                    asking = false;
                    String url = tidy(box.getText().toString());
                    if (url.isEmpty()) { askAddress(getString(R.string.err_address)); return; }
                    prefs().edit().putString(KEY_SERVER, url).apply();
                    web.loadUrl(url);
                    web.requestFocus();
                })
                .setNegativeButton(first ? R.string.ask_leave : android.R.string.cancel, (d, w) -> {
                    asking = false;
                    if (first) finish();
                })
                .setOnCancelListener(d -> asking = false);
        b.show();
        box.requestFocus();
    }

    /** What the server's pages can ask of the app (nothing else is exposed). */
    private final class Bridge {
        /** Back was pressed at Home, twice: leave the app. */
        @JavascriptInterface
        public void exit() {
            runOnUiThread(MainActivity.this::finish);
        }

        /** Ask for the server's address again. */
        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(() -> askAddress(null));
        }
    }

    @Override
    public boolean onKeyLongPress(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) { askAddress(null); return true; }
        return super.onKeyLongPress(keyCode, event);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) { event.startTracking(); return true; } // (acted on when it's let go: holding it asks for the address)
        if (keyCode == KeyEvent.KEYCODE_MENU) { askAddress(null); return true; }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && event.isTracking() && !event.isCanceled()) {
            if (fullView != null) { leaveFullScreen(); return true; }
            // The app's pages get the key a TV browser would send for Back, and decide: close a menu, go back, or
            // leave (TvApp.exit()). Any other page (the sign-in page, an error) has nobody listening: back, or out.
            web.evaluateJavascript("(function(){if(!window.V||!window.V.router)return 'none';var t=document.activeElement||document.body,"
                    + "e=document.createEvent('Event');e.initEvent('keydown',true,true);e.keyCode=10009;e.which=10009;e.key='GoBack';"
                    + "t.dispatchEvent(e);return 'app';})()", result -> {
                        if (result != null && result.contains("app")) return;
                        if (web.canGoBack()) web.goBack(); else finish();
                    });
            return true;
        }
        return super.onKeyUp(keyCode, event);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        root.removeAllViews();
        web.destroy();
        super.onDestroy();
    }
}
