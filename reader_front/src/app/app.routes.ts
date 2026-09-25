// app.routes.ts
import { Routes, ActivatedRouteSnapshot } from '@angular/router';
import { inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { HomeComponent } from './home/home.component';
import { CategoryComponent } from './category/category.component';
import { ArticleDetailComponent } from './articlepage/app-article-detail.component';
import { Article } from './articlepage/article.model';
import { catchError, map, of } from 'rxjs';
import { AboutComponent } from './about/about.component';
import { StaticPageComponent } from './static-page/static-page.component';
import { ContactComponent } from './contact/contact.component';

const staticHtml = (file: string) => () =>
  inject(HttpClient).get(`/pages/${file}`, { responseType: 'text' }).pipe(
    catchError(err => {
      console.error(`${file} resolve failed`, err);
      return of(null);
    })
  );

export const routes: Routes = [
  {
    path: 'home',
    component: HomeComponent,
    resolve: {
      articlePool: () =>
        inject(HttpClient).get<{ articlePool: any[] }>('/api/home-page').pipe(
          map(res => res.articlePool),
          catchError(err => {
            console.error('home-page resolve failed', err);
            return of(null);
          })
        )
    }
  },
  {
    path: 'category/:name',
    component: CategoryComponent,
    resolve: {
      articlePool: (route: ActivatedRouteSnapshot) =>
        inject(HttpClient).get<{ articlePool: any[] }>(`/api/category/${route.paramMap.get('name')}`).pipe(
          map(res => res.articlePool),
          catchError(err => {
            console.error('category resolve failed', err);
            return of(null);
          })
        )
    }
  },
  {
    path: 'article/:slug',
    component: ArticleDetailComponent,
    resolve: {
      // ArticleDetailController returns the Article shape directly — no
      // wrapper key to unwrap, unlike /api/home-page's { articlePool }.
      // Typed explicitly as Article: the object established in
      // article.model.ts is what flows through the resolver into the
      // component, not an untyped stand-in the component has to cast.
      article: (route: ActivatedRouteSnapshot) =>
        inject(HttpClient).get<Article>(`/api/articles/${route.paramMap.get('slug')}`).pipe(
          catchError(err => {
            console.error('article resolve failed', err);
            return of(null);
          })
        )
    }
  },
   { path: 'about', component: AboutComponent },
   { path: 'contact', component: ContactComponent },
  {
    path: 'terms',
    component: StaticPageComponent,
    data: { title: '使用條款' },
    resolve: { html: staticHtml('terms.html') }
  },
  {
    path: 'privacy',
    component: StaticPageComponent,
    data: { title: '隱私權保護聲明' },
    resolve: { html: staticHtml('privacy.html') }
  },
  { path: '', redirectTo: '/home', pathMatch: 'full' }
];
