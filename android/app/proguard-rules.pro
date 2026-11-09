# 0.3.7 起 release 开启 R8（isMinifyEnabled = true）。
#
# 保留 App 自身全部类：Activity / AppWidgetProvider / WorkManager Worker 都由系统或
# AndroidX 按类名反射实例化，R8 看不到这些引用；App 类体量很小，整体保留最稳。
-keep class com.paulcai1593.fncal.app.** { *; }

# WebView 的 JS 接口（@JavascriptInterface 方法）只从网页按名字调用，R8 必须保留成员。
-keepclassmembers class com.paulcai1593.fncal.app.BlobSaver {
    public *;
}

# 其余交给 AndroidX 自带的 consumer rules；不自己加 -dontwarn 大网，
# 免得把真正的缺类警告吞掉。
