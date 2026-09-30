import os
import sys
from dotenv import load_dotenv #pip install dotenv
from langchain_google_genai import ChatGoogleGenerativeAI #pip install langchain_google_genai
from langchain_core.prompts import ChatPromptTemplate #pip install langchain_core
from langchain_core.output_parsers import StrOutputParser
from langchain_core.messages import HumanMessage


def _set_llm():
    '''
        refracting role, hard code prompt for now.
    :return:
    '''
    dotenv_path = os.path.join(os.path.expanduser('~'), '.env')
    _ = load_dotenv(dotenv_path)  # read local .env
    gemini_api_key = os.getenv('GEMINI-API-KEY')
    llm = ChatGoogleGenerativeAI(
        model="gemini-3.1-pro-preview",
        google_api_key=gemini_api_key,
        temperature=0.1
    )
    return llm

def _set_prompt(article):
    '''
        refractoring role, hard code prompt for now.
    :return:
    '''
    template = '''
            The input in triple backticks is an article
            or a video. Your job is to provide a brief subtitle around 110 chinese 
            characters.

            be direct in your phrasing. do not add AI padding. 
            simply relay what is in the article


        ```input:{input}```
    '''
    templated_prompt = ChatPromptTemplate.from_template(template)
    expanded_prompt = templated_prompt.format_messages(input = article)
    return expanded_prompt


_MEDIA_NOTE = '''
            The attached audio is the video's soundtrack and the images are
            frames from it. Take the story from the narration; use on-screen
            text only for names, places, and titles.
'''

# Built once at import; subtitle_sync.py calls generate_subtitle() per article.
_chain = _set_llm() | StrOutputParser()

def generate_subtitle(article, media=None):
    '''
        media: optional list of LangChain content blocks (audio / image)
        from subtitle_sync.video_input().
    '''
    if not media:
        return _chain.invoke(_set_prompt(article)).strip()
    prompt_text = _set_prompt(article)[0].content + _MEDIA_NOTE
    message = HumanMessage(content=[{"type": "text", "text": prompt_text}, *media])
    return _chain.invoke([message]).strip()


if __name__ == '__main__':
    # manual run: python llm.py some_article.txt
    with open(sys.argv[1], encoding='utf-8') as f:
        print(generate_subtitle(f.read()))
