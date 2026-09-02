package com.fss.caisse.printer;

import android.content.Context;
import android.os.Build;

public class PrinterDriverFactory {

    private static PrinterDriver instance;

    public static synchronized PrinterDriver get(Context context) {
        if (instance == null) {
            String manufacturer = safe(Build.MANUFACTURER) + " " + safe(Build.BRAND) + " " + safe(Build.MODEL);
            String m = manufacturer.toLowerCase();
            if (m.contains("sunmi")) {
                instance = new SunmiPrinterDriver(context);
            } else {
                // Senraise H10S et tout autre appareil non reconnu retombent sur le stub H10S,
                // à compléter avec le SDK du fabricant concerné (voir H10sPrinterDriver.java).
                instance = new H10sPrinterDriver(context);
            }
        }
        return instance;
    }

    private static String safe(String s) {
        return s == null ? "" : s;
    }
}
