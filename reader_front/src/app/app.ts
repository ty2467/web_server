import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { forkJoin, map } from 'rxjs';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, CommonModule],
  templateUrl: './app.html',
  styleUrls: ['./app.css'],
})
export class App implements OnInit {
  private http = inject(HttpClient);

  menuItems: string[] = [
    '美洲头条',
    '天天话题',
    '美国观察',
    '工商新闻',
    '出海专区',
    'CES消费电子展',
    '美洲台探访',
    '商务合作',
    '中美关系'
  ];

  stockData: any[] = [];
  private symbols = [
    '^GSPC',
    '^IXIC',
    '^DJI',
    'AAPL',
    'MSFT',
    'GOOGL',
    'AMZN',
    'NVDA',
    'META',
    'TSLA',
    'BRK.B',
    'LLY',
    'AVGO',
    'V',
    'JPM',
    'NVO',
    'UNH',
    'WMT',
    'MA',
    'JNJ',
    'PG',
    'HD',
  ];

  private apiKey = 'd7np7khr01qm36379nsgd7np7khr01qm36379nt0';

  ngOnInit() {
    this.fetchStockData();
  }

  fetchStockData() {
    const requests = this.symbols.map((symbol) =>
      this.http.get(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${this.apiKey}`).pipe(
        map((res: any) => ({
          symbol,
          price: res.c,
          change: res.d,
          percent: res.dp,
        })),
      ),
    );

    forkJoin(requests).subscribe({
      next: (data) => (this.stockData = data),
      error: (err) => console.error('Stock fetch failed', err),
    });
  }
}
