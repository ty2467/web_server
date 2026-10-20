# Project pages and structure
### [writer_front](ws/wf.md)
### [writer_back: apis](ws/wb.md)
### [writer_back helpers and structures](ws/wb_helper.md)
### [reader_front](ws/rf.md)
### [reader_back apis](ws/rb.md)
### [reader_back helpers and structures](ws/rb_helper.md)
### [2home_page-mdwr](ws/2home.md)
### [2article_display_mdwr](ws/2article.md)
### [2llm_subtitle_mdwr](ws/2llm.md)
```
web_server/
├── 2article_display_mdwr/src/
│   └── main/
│       └── java/
│           └── org/
│               └── example/
│                     EditorsDisplaySync.java
├── 2home_page-mdwr/src/
│   └── main/
│       └── java/
│           ├── org/
│           │   └── example/
│           │         HomePageSync.java
│           └── renditions/
│                 RenditionHook.java, Renditions.java
├── reader_back/src/
│   │ .DS_Store
│   └── main/
│       │ .DS_Store
│       ├── java/
│       │   │ .DS_Store
│       │   └── com/
│       │       │ .DS_Store
│       │       └── example/
│       │           │ .DS_Store
│       │           └── demo/
│       │                 ArticleDetailController.java,
│       │                 SpringBootTutorialApplication.java
│       └── resources/
│           │ .DS_Store, application.properties
│           └── static/
│               │ .DS_Store, MainLogo.png, dl.sh, index.html,
│               │ main-TFWP6N46.js
│               ├── about/
│               │     Slide01.png, ..., Slide29.png, collage.png, logo.png
│               └── pages/
│                     privacy.html, terms.html
├── reader_front/src/
│   │ index.html, main.ts, styles.css
│   └── app/
│       │ App.java, app.config.ts, app.css, app.html, app.routes.ts,
│       │ app.spec.ts, app.ts, layout.model.ts, safe-url.pipe.ts
│       ├── about/
│       │     about.component.ts
│       ├── articlepage/
│       │     app-article-detail.component.ts,
│       │     article-detail.component.html,
│       │     article-detail.component.scss, article.model.ts
│       ├── category/
│       │     category.component.css, category.component.html,
│       │     category.component.ts
│       ├── contact/
│       │     contact.component.css, contact.component.html,
│       │     contact.component.ts
│       ├── home/
│       │     delayed-media.component.ts, home.component.css,
│       │     home.component.html, home.component.ts
│       └── static-page/
│             static-page.component.ts
├── writer_back/src/
│   └── main/
│       ├── java/
│       │   └── com/
│       │       └── example/
│       │           └── demo/
│       │                 EditorsDbEventPublisher.java,
│       │                 SpringBootTutorialApplication.java,
│       │                 TitleEmbedder.java
│       └── resources/
│           │ application.properties
│           └── static/
│                 app.log, dl.sh, favicon.ico, index.html,
│                 main-ZC2W2OKH.js, styles-5INURTSO.css
└── writer_front/src/
    │ index.html, main.ts, styles.css
    └── app/
        │ app.config.ts, app.css, app.html, app.routes.ts,
        │ app.spec.ts, app.ts
        ├── dashboard/
        │   │ dashboard.component.css, dashboard.component.html,
        │   │ dashboard.component.ts
        │   └── archive/
        │         dashboard.component.css, dashboard.component.html,
        │         dashboard.component.ts
        ├── ingest/
        │     image-block.component.ts, ingest-block.model.ts,
        │     ingest.component.css, ingest.component.html,
        │     ingest.component.ts, media-blocks.css, media-nodes.ts,
        │     media-upload.service.ts, paste.util.ts,
        │     video-block.component.ts
        └── models/
              paragraph.ts

```
